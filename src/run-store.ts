import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    ArtifactStore,
    artifactStorePathForRunStore,
    type ArtifactReadResult,
    type ArtifactStoreMetrics,
    type ArtifactStoreOptions,
    type StoredArtifactView
} from './artifact-store.js'
import type {
    AgentdArtifact,
    AgentdProtocol,
    AgentdRunArtifactView,
    AgentdRunDetail,
    AgentdRunProgress,
    AgentdRunView,
    AgentdSessionState
} from './types.js'

export {
    ArtifactStore,
    artifactStorePathForRunStore
} from './artifact-store.js'
export type {
    ArtifactReadResult,
    ArtifactStorageStatus,
    ArtifactStoreMetrics,
    ArtifactStoreIo,
    ArtifactStoreOptions,
    StoredArtifactView
} from './artifact-store.js'

interface StoredRun extends Omit<AgentdRunDetail, 'taskPreview'> {
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
    inputAttachmentCount?: number
    retryOfRunId?: string
}

export interface RunStoreOptions extends ArtifactStoreOptions {
    /** History count cap; the positional maxRuns argument takes precedence. */
    maxRuns?: number
    /** Task text cap; the positional maxTaskChars argument takes precedence. */
    maxTaskChars?: number
    /** Terminal run metadata retention duration. Active runs are protected. */
    historyRetentionDays?: number
    /** JSON run-history byte budget, independent from artifact payload bytes. */
    historyMaxBytes?: number
}

export interface RunListQuery {
    agentId?: string
    sessionId?: string
    state?: AgentdSessionState
    query?: string
    limit?: number
    offset?: number
}

export interface RunArtifactQuery {
    agentId?: string
    /** 'all' keeps every kind; otherwise one of artifactKind() values. */
    kind?: string
    query?: string
    limit?: number
    offset?: number
}

export interface RunArtifactRow {
    id: string
    runId: string
    agentId: string
    agentName: string
    runState: AgentdSessionState
    runStartedAt: number
    name?: string
    filename?: string
    mediaType?: string
    size?: number
    kind: string
    downloadable: boolean
    storageStatus?: string
    createdAt?: number
}

/** Coarse bucket used by the console filter and list grouping. */
export function artifactKind(mediaType: string | undefined) {
    const type = String(mediaType || '').toLowerCase()
    if (type.startsWith('image/')) return 'image'
    if (type.startsWith('video/')) return 'video'
    if (type.startsWith('audio/')) return 'audio'
    return 'file'
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
    readonly artifactStore: ArtifactStore
    private readonly maxRuns: number
    private readonly maxTaskChars: number
    private readonly historyRetentionDays?: number
    private readonly historyMaxBytes?: number
    private readonly now: () => number
    private lastWriteMs = 0
    private writeFailures = 0
    private historyBytes = 0

    constructor(filePath: string, maxRuns?: number, maxTaskChars?: number | RunStoreOptions, options?: RunStoreOptions)
    constructor(filePath: string, options?: RunStoreOptions)
    constructor(
        readonly filePath: string,
        maxRunsOrOptions: number | RunStoreOptions = 1000,
        maxTaskCharsOrOptions: number | RunStoreOptions | undefined = undefined,
        suppliedOptions: RunStoreOptions = {}
    ) {
        const positionalOptions: RunStoreOptions =
            typeof maxRunsOrOptions === 'object' ? maxRunsOrOptions : { ...suppliedOptions }
        if (typeof maxTaskCharsOrOptions === 'object') {
            Object.assign(positionalOptions, maxTaskCharsOrOptions)
        }
        this.maxRuns = positiveInteger(
            typeof maxRunsOrOptions === 'number'
                ? maxRunsOrOptions
                : positionalOptions.maxRuns,
            1000
        )
        this.maxTaskChars = positiveInteger(
            typeof maxTaskCharsOrOptions === 'number'
                ? maxTaskCharsOrOptions
                : maxTaskCharsOrOptions?.maxTaskChars ?? positionalOptions.maxTaskChars,
            1024 * 1024
        )
        this.historyRetentionDays = nonNegativeNumber(
            positionalOptions.historyRetentionDays,
            undefined
        )
        this.historyMaxBytes = nonNegativeInteger(
            positionalOptions.historyMaxBytes,
            undefined
        )
        this.now = positionalOptions.now || Date.now
        const artifactRoot =
            positionalOptions.rootDir ||
            positionalOptions.artifactRootDir ||
            artifactStorePathForRunStore(filePath)
        this.artifactStore = new ArtifactStore(artifactRoot, {
            ...positionalOptions,
            onViewsChanged: (runId, views) => this.applyArtifactViews(runId, views),
            isRunActive: (runId) => isActive(this.runs.get(runId)?.state)
        })
    }

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
        const now = this.now()
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
        await this.artifactStore.init()
        for (const [id, run] of this.runs) {
            const views = this.artifactStore.restoreRun(id, run.artifacts)
            if (JSON.stringify(run.artifacts) !== JSON.stringify(views)) {
                run.artifacts = views
                run.artifactCount = views.length
                this.dirty = true
            }
        }
        this.initialized = true
        this.prune()
        if (!(await fileExists(this.filePath))) this.dirty = true
        if (this.dirty) await this.flush()
    }

    create(input: CreateRunInput) {
        this.assertInitialized()
        const now = this.now()
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
            retryOfRunId: input.retryOfRunId,
            inputAttachmentCount: input.inputAttachmentCount || undefined,
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
                | 'inputAttachmentCount'
                | 'completion'
                | 'retryOfRunId'
            >
        >
    ) {
        this.assertInitialized()
        const current = this.runs.get(id)
        if (!current) return undefined
        const output = patch.output === undefined
            ? current.output
            : clipTail(patch.output, MAX_OUTPUT_CHARS)
        const updatedAt = patch.updatedAt ?? this.now()
        const normalizedPatch = structuredClone(patch) as typeof patch
        if (patch.artifacts !== undefined) {
            normalizedPatch.artifacts = this.artifactStore.mergeViews(id, patch.artifacts, false)
            normalizedPatch.artifactCount = normalizedPatch.artifacts.length
        }
        const next: StoredRun = {
            ...current,
            ...normalizedPatch,
            output,
            resultSummary: output ? summarize(output) : current.resultSummary,
            updatedAt
        }
        if (patch.endedAt !== undefined) {
            next.durationMs = Math.max(0, patch.endedAt - next.startedAt)
        }
        // Preserve creation order as the stable tie-breaker for same-ms tasks.
        this.runs.set(id, next)
        this.changed()
        return publicDetail(next)
    }

    /** Queue payload snapshots without blocking the protocol sink. */
    recordArtifacts(runId: string, artifacts: AgentdArtifact[]) {
        this.assertInitialized()
        if (!this.runs.has(runId)) return undefined
        return this.artifactStore.recordArtifacts(runId, artifacts)
    }

    artifactViews(runId: string): StoredArtifactView[] | undefined {
        this.assertInitialized()
        if (!this.runs.has(runId)) return undefined
        return this.artifactStore.views(runId)
    }

    async readArtifact(runId: string, artifactId: string): Promise<ArtifactReadResult | undefined> {
        this.assertInitialized()
        if (!this.runs.has(runId)) return undefined
        return this.artifactStore.readArtifact(runId, artifactId)
    }

    /** Flat, newest-first artifact index across all retained runs. */
    listArtifacts(query: RunArtifactQuery = {}) {
        this.assertInitialized()
        const needle = String(query.query || '').trim().toLowerCase()
        const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
        const offset = Math.max(0, Math.floor(Number(query.offset) || 0))
        const rows: RunArtifactRow[] = []
        for (const run of this.runs.values()) {
            for (const view of run.artifacts || []) {
                if (!view.id) continue
                if (query.agentId && run.agentId !== query.agentId) continue
                const kind = artifactKind(view.mediaType)
                if (query.kind && query.kind !== 'all' && kind !== query.kind) continue
                if (needle) {
                    const haystack = `${view.name || ''} ${view.filename || ''}`.toLowerCase()
                    if (!haystack.includes(needle)) continue
                }
                rows.push({
                    id: view.id,
                    runId: run.id,
                    agentId: run.agentId,
                    agentName: run.agentName,
                    runState: run.state,
                    runStartedAt: run.startedAt,
                    name: view.name,
                    filename: view.filename,
                    mediaType: view.mediaType,
                    size: view.size,
                    kind,
                    downloadable: view.downloadable === true,
                    storageStatus: view.storageStatus,
                    createdAt: view.createdAt
                })
            }
        }
        rows.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0))
        return { artifacts: rows.slice(offset, offset + limit), total: rows.length }
    }

    /** Delete one artifact's payload and record entry; the run record stays. */
    async removeArtifact(runId: string, artifactId: string) {
        this.assertInitialized()
        if (!this.runs.has(runId)) return false
        return this.artifactStore.removeArtifact(runId, artifactId)
    }

    getOwnerKeyId(runId: string) {
        this.assertInitialized()
        return this.runs.get(runId)?.ownerKeyId
    }

    metrics() {
        const artifactStoreStats: ArtifactStoreMetrics = this.artifactStore.stats()
        return {
            // This is the last successfully persisted JSON size. A dirty store
            // reports that size until its queued write completes, avoiding a
            // full-history serialization on every metrics poll.
            historyBytes: this.historyBytes,
            retainedRuns: this.runs.size,
            pendingWrites: (this.dirty ? 1 : 0) + artifactStoreStats.pendingWrites,
            lastWriteMs: this.lastWriteMs,
            writeFailures: this.writeFailures,
            artifactStoreStats
        }
    }

    stats() {
        return this.metrics()
    }

    setRetryOfRunId(runId: string, retryOfRunId?: string) {
        return this.update(runId, { retryOfRunId } as Partial<Pick<StoredRun, 'retryOfRunId'>>)
    }

    /**
     * Remove a terminal run record and its stored artifacts. Active runs are
     * refused so a live turn cannot lose its progress tracking.
     */
    deleteRun(id: string) {
        this.assertInitialized()
        const run = this.runs.get(id)
        if (!run) return undefined
        if (isActive(run.state)) return undefined
        this.runs.delete(id)
        this.artifactStore.removeRun(id)
        this.changed()
        return publicDetail(run)
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
        const offset = Math.max(0, Math.floor(Number(query.offset) || 0))
        const matched = Array.from(this.runs.values())
            .reverse()
            .sort((left, right) => right.startedAt - left.startedAt)
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
        const stats = { active: 0, completed: 0, failed: 0 }
        for (const run of matched) {
            if (isActive(run.state)) stats.active++
            if (run.state === 'completed') stats.completed++
            if (run.state === 'failed') stats.failed++
        }
        const runs = matched.slice(offset, offset + limit).map(publicView)
        return { runs, total, stats }
    }

    async flush() {
        this.assertInitialized()
        if (this.persistTimer) clearTimeout(this.persistTimer)
        this.persistTimer = undefined
        if (this.dirty) await this.persist()
        await this.artifactStore.flush()
        // Successful artifact commits update run metadata via the callback
        // above, so persist those storage facts as well.
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
        this.historyBytes = Buffer.byteLength(raw)
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
        const removeOldestTerminal = (predicate: (run: StoredRun) => boolean) => {
            const terminal = Array.from(this.runs.entries())
                .filter(([, run]) => !isActive(run.state) && predicate(run))
                .sort(([, left], [, right]) => left.updatedAt - right.updatedAt)[0]
            if (!terminal) return false
            this.runs.delete(terminal[0])
            this.artifactStore.removeRun(terminal[0])
            this.dirty = true
            return true
        }
        while (this.runs.size > this.maxRuns) {
            if (!removeOldestTerminal(() => true)) break
        }
        if (this.historyRetentionDays !== undefined) {
            const cutoff = this.now() - this.historyRetentionDays * 24 * 60 * 60 * 1000
            while (removeOldestTerminal((run) => (run.endedAt ?? run.updatedAt) <= cutoff)) {}
        }
        if (this.historyMaxBytes !== undefined) {
            const historyBytes = () => Buffer.byteLength(JSON.stringify(Array.from(this.runs.values())))
            while (historyBytes() > this.historyMaxBytes) {
                if (!removeOldestTerminal(() => true)) {
                    console.error(JSON.stringify({
                        level: 'warn',
                        event: 'run_history_budget_exceeded',
                        bytes: historyBytes(),
                        budget: this.historyMaxBytes,
                        activeRunsProtected: Array.from(this.runs.values()).filter((run) => isActive(run.state)).length
                    }))
                    break
                }
            }
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
            const startedAt = this.now()
            const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
            try {
                await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600 })
                await rename(temp, this.filePath)
                await chmod(this.filePath, 0o600).catch(() => undefined)
                this.historyBytes = Buffer.byteLength(serialized)
                this.lastWriteMs = Math.max(0, this.now() - startedAt)
            } finally {
                await unlink(temp).catch(() => undefined)
            }
        }
        const next = this.writeQueue.then(write, write).catch((error) => {
            this.dirty = true
            this.writeFailures++
            throw error
        })
        this.writeQueue = next.catch(() => undefined)
        return next
    }

    private assertInitialized() {
        if (!this.initialized) throw new Error('RunStore is not initialized')
    }

    private applyArtifactViews(runId: string, views: StoredArtifactView[]) {
        const run = this.runs.get(runId)
        if (!run) return
        run.artifacts = structuredClone(views)
        run.artifactCount = run.artifacts.length
        run.updatedAt = this.now()
        if (!this.initialized) {
            this.dirty = true
            return
        }
        this.changed()
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

function positiveInteger(value: number | undefined, fallback: number) {
    return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number | undefined) {
    return Number.isFinite(value) && Number(value) >= 0 ? Math.floor(Number(value)) : fallback
}

function nonNegativeNumber(value: number | undefined, fallback: number | undefined) {
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback
}

function publicView(run: StoredRun): AgentdRunView {
    const { ownerKeyId: _ownerKeyId, task, output: _output, artifacts: _artifacts, ...view } = run
    return structuredClone({ ...view, taskPreview: task.slice(0, 240),
        // Remote errors/progress can be large too; full values remain in details.
        error: view.error?.slice(0, 600),
        progress: { ...view.progress, phase: view.progress.phase.slice(0, 120), message: view.progress.message?.slice(0, 600) }
    })
}

function publicDetail(run: StoredRun): AgentdRunDetail {
    const { ownerKeyId: _ownerKeyId, ...detail } = run
    return structuredClone({ ...detail, taskPreview: run.task.slice(0, 240) })
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

function isActive(state: AgentdSessionState | undefined) {
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
