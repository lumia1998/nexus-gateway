import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
    AgentdProtocol,
    AgentdRunArtifactView,
    AgentdRunDetail,
    AgentdRunProgress,
    AgentdRunView,
    AgentdSessionState
} from './types.js'

interface StoredRun extends AgentdRunDetail {
    ownerKeyId: string
}

interface RunFile {
    schemaVersion: 1
    runs: StoredRun[]
}

export interface CreateRunInput {
    sessionId: string
    agentId: string
    agentName: string
    protocol: AgentdProtocol
    workspace?: string
    protocolSessionId?: string
    ownerKeyId: string
    task: string
}

export interface RunListQuery {
    agentId?: string
    sessionId?: string
    state?: AgentdSessionState
    query?: string
    limit?: number
}

const STATES = new Set<AgentdSessionState>([
    'created',
    'running',
    'input_required',
    'permission_required',
    'completed',
    'failed',
    'canceled'
])
const MAX_OUTPUT_CHARS = 256 * 1024
const MAX_SUMMARY_CHARS = 600

export class RunStore {
    private readonly runs = new Map<string, StoredRun>()
    private initialized = false
    private dirty = false
    private persistTimer?: NodeJS.Timeout
    private writeQueue = Promise.resolve()

    constructor(
        readonly filePath: string,
        private readonly maxRuns = 1000,
        private readonly maxTaskChars = 1024 * 1024
    ) {}

    async init() {
        if (this.initialized) return
        await mkdir(path.dirname(this.filePath), { recursive: true })
        try {
            const raw = await readFile(this.filePath, 'utf8')
            this.load(raw)
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                if (error instanceof SyntaxError || error instanceof InvalidRunFileError) {
                    const backup = `${this.filePath}.corrupt-${Date.now()}`
                    await rename(this.filePath, backup)
                    console.error(
                        JSON.stringify({
                            level: 'error',
                            event: 'run_history_recovered',
                            file: this.filePath,
                            backup,
                            message: error.message
                        })
                    )
                } else {
                    throw error
                }
            }
        }
        this.initialized = true
        const now = Date.now()
        for (const [id, run] of this.runs) {
            if (!isActive(run.state)) continue
            this.runs.set(id, {
                ...run,
                state: 'failed',
                error: 'Gateway restarted before the task finished.',
                progress: { phase: '已中断', message: '网关重启前任务尚未结束' },
                updatedAt: now,
                endedAt: now,
                durationMs: Math.max(0, now - run.startedAt)
            })
            this.dirty = true
        }
        this.prune()
        if (!(await fileExists(this.filePath))) this.dirty = true
        if (this.dirty) await this.flush()
    }

    create(input: CreateRunInput) {
        this.assertInitialized()
        const now = Date.now()
        const taskTruncated = input.task.length > this.maxTaskChars
        const run: StoredRun = {
            id: randomUUID(),
            sessionId: input.sessionId,
            agentId: input.agentId,
            agentName: input.agentName,
            protocol: input.protocol,
            workspace: input.workspace,
            protocolSessionId: input.protocolSessionId,
            ownerKeyId: input.ownerKeyId,
            task: taskTruncated ? input.task.slice(0, this.maxTaskChars) : input.task,
            taskTruncated: taskTruncated || undefined,
            state: 'running',
            progress: { phase: '已接收', message: '任务已交给智能体' },
            artifacts: [],
            artifactCount: 0,
            startedAt: now,
            updatedAt: now
        }
        this.runs.set(run.id, run)
        this.changed()
        return publicDetail(run)
    }

    update(
        id: string,
        patch: Partial<
            Pick<
                StoredRun,
                | 'protocolSessionId'
                | 'state'
                | 'progress'
                | 'output'
                | 'error'
                | 'artifacts'
                | 'artifactCount'
                | 'updatedAt'
                | 'endedAt'
                | 'durationMs'
            >
        >
    ) {
        this.assertInitialized()
        const current = this.runs.get(id)
        if (!current) return undefined
        const output = patch.output === undefined
            ? current.output
            : clipTail(patch.output, MAX_OUTPUT_CHARS)
        const updatedAt = patch.updatedAt ?? Date.now()
        const next: StoredRun = {
            ...current,
            ...structuredClone(patch),
            output,
            resultSummary: output ? summarize(output) : current.resultSummary,
            updatedAt
        }
        if (patch.endedAt !== undefined) {
            next.durationMs = Math.max(0, patch.endedAt - next.startedAt)
        }
        this.runs.delete(id)
        this.runs.set(id, next)
        this.changed()
        return publicDetail(next)
    }

    get(id: string) {
        this.assertInitialized()
        const run = this.runs.get(id)
        return run ? publicDetail(run) : undefined
    }

    list(query: RunListQuery = {}) {
        this.assertInitialized()
        const needle = String(query.query || '').trim().toLowerCase()
        const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
        const matched = Array.from(this.runs.values())
            .reverse()
            .filter((run) => !query.agentId || run.agentId === query.agentId)
            .filter((run) => !query.sessionId || run.sessionId === query.sessionId)
            .filter((run) => !query.state || run.state === query.state)
            .filter(
                (run) =>
                    !needle ||
                    run.task.toLowerCase().includes(needle) ||
                    run.agentName.toLowerCase().includes(needle) ||
                    run.id.toLowerCase().includes(needle)
            )
        const total = matched.length
        const runs = matched.slice(0, limit).map(publicView)
        return { runs, total }
    }

    async flush() {
        this.assertInitialized()
        if (this.persistTimer) clearTimeout(this.persistTimer)
        this.persistTimer = undefined
        if (this.dirty) await this.persist()
        await this.writeQueue
    }

    private load(raw: string) {
        const parsed = JSON.parse(raw) as unknown
        if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            (parsed as any).schemaVersion !== 1 ||
            !Array.isArray((parsed as any).runs)
        ) {
            throw new InvalidRunFileError('Invalid Agent Nexus run history file')
        }
        for (const value of (parsed as RunFile).runs) {
            const run = normalizeRun(value)
            if (run) this.runs.set(run.id, run)
        }
    }

    private changed() {
        this.dirty = true
        this.prune()
        if (this.persistTimer) return
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined
            void this.persist().catch((error) => {
                console.error(
                    JSON.stringify({
                        level: 'error',
                        event: 'run_history_write_failed',
                        message: error instanceof Error ? error.message : String(error)
                    })
                )
            })
        }, 250)
        this.persistTimer.unref?.()
    }

    private prune() {
        while (this.runs.size > this.maxRuns) {
            const terminal = Array.from(this.runs.entries()).find(
                ([, run]) => !isActive(run.state)
            )
            if (!terminal) break
            this.runs.delete(terminal[0])
            this.dirty = true
        }
    }

    private persist() {
        if (!this.dirty) return this.writeQueue
        this.dirty = false
        const payload: RunFile = {
            schemaVersion: 1,
            runs: Array.from(this.runs.values()).map((run) => structuredClone(run))
        }
        const serialized = `${JSON.stringify(payload, null, 2)}\n`
        const write = async () => {
            const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
            await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })
            await rename(temp, this.filePath)
            await chmod(this.filePath, 0o600).catch(() => undefined)
        }
        const next = this.writeQueue.then(write, write).catch((error) => {
            this.dirty = true
            throw error
        })
        this.writeQueue = next.catch(() => undefined)
        return next
    }

    private assertInitialized() {
        if (!this.initialized) throw new Error('RunStore is not initialized')
    }
}

export function runStorePathForConfig(configPath: string) {
    const absolute = path.resolve(configPath)
    const extension = path.extname(absolute)
    const basename = path.basename(absolute, extension)
    return path.join(path.dirname(absolute), `${basename}-runs.json`)
}

function normalizeRun(value: unknown): StoredRun | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const run = value as StoredRun
    if (
        typeof run.id !== 'string' ||
        typeof run.sessionId !== 'string' ||
        typeof run.agentId !== 'string' ||
        typeof run.agentName !== 'string' ||
        (run.protocol !== 'acp' && run.protocol !== 'a2a') ||
        typeof run.ownerKeyId !== 'string' ||
        typeof run.task !== 'string' ||
        !STATES.has(run.state) ||
        !run.progress ||
        typeof run.progress.phase !== 'string' ||
        !Number.isFinite(run.startedAt) ||
        !Number.isFinite(run.updatedAt)
    ) {
        return undefined
    }
    return {
        ...structuredClone(run),
        artifacts: Array.isArray(run.artifacts) ? structuredClone(run.artifacts) : [],
        artifactCount: Number.isFinite(run.artifactCount) ? run.artifactCount : 0
    }
}

function publicView(run: StoredRun): AgentdRunView {
    const { ownerKeyId: _ownerKeyId, output: _output, artifacts: _artifacts, ...view } = run
    return structuredClone(view)
}

function publicDetail(run: StoredRun): AgentdRunDetail {
    const { ownerKeyId: _ownerKeyId, ...detail } = run
    return structuredClone(detail)
}

function summarize(value: string) {
    const compact = value.replace(/\s+/g, ' ').trim()
    return compact.length > MAX_SUMMARY_CHARS
        ? `${compact.slice(0, MAX_SUMMARY_CHARS)}…`
        : compact
}

function clipTail(value: string, max: number) {
    return value.length <= max
        ? value
        : `…[truncated by Agent Nexus]\n${value.slice(-max)}`
}

function isActive(state: AgentdSessionState) {
    return state === 'running' || state === 'input_required' || state === 'permission_required'
}

async function fileExists(filePath: string) {
    try {
        await readFile(filePath)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

class InvalidRunFileError extends Error {}
