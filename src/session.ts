import { randomUUID } from 'node:crypto'
import { AcpProcessRuntime } from './acp/runtime.js'
import { A2AClientRuntime, probeA2AAgent } from './a2a/runtime.js'
import type { AgentDriver } from './drivers/index.js'
import { SessionEventLog } from './events.js'
import { RunStore, type RunListQuery } from './run-store.js'
import type {
    AcpSessionSink,
    AgentSessionRuntime,
    AgentSessionSink
} from './session-contract.js'
import type {
    AgentdAgentView,
    AgentdArtifact,
    AgentdConfig,
    AgentdEvent,
    AgentdEventType,
    AgentdInputAttachment,
    AgentdInputAttachmentView,
    AgentdPendingRequest,
    AgentdProtocol,
    AgentdRunProgress,
    AgentdSessionState,
    AgentdSessionView
} from './types.js'
import type { WorkspacePolicy } from './workspace.js'

const MAX_SESSION_ARTIFACTS = 64
const MAX_ARTIFACT_BASE64_CHARS = 16 * 1024 * 1024
const MAX_SESSION_BASE64_CHARS = 32 * 1024 * 1024
const READINESS_CACHE_MS = 20_000
const MAX_INPUT_ATTACHMENTS = 16
const MAX_INPUT_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_SESSION_INPUT_BYTES = 32 * 1024 * 1024

export class ManagedSession implements AgentSessionSink, AcpSessionSink {
    readonly id = randomUUID()
    readonly createdAt = Date.now()
    readonly events: SessionEventLog
    state: AgentdSessionState = 'created'
    updatedAt = this.createdAt
    protocolSessionId?: string
    acpSessionId?: string
    output = ''
    error?: string
    pendingRequest?: AgentdPendingRequest
    private artifacts: AgentdArtifact[] = []
    private inputAttachments = new Map<string, AgentdInputAttachment>()
    private runtime?: AgentSessionRuntime

    constructor(
        readonly agentId: string,
        readonly protocol: AgentdProtocol,
        readonly workspace: string | undefined,
        readonly ownerKeyId: string,
        maxEvents: number,
        private readonly maxOutputChars: number,
        private readonly agentName: string,
        private readonly runStore?: RunStore
    ) {
        this.events = new SessionEventLog(this.id, maxEvents)
        this.events.append('session_state', { state: this.state, protocol })
    }

    attach(runtime: AgentSessionRuntime) {
        this.runtime = runtime
    }

    setProtocolSessionId(id: string) {
        this.protocolSessionId = id
        this.updatedAt = Date.now()
        this.syncRun({ protocolSessionId: id })
    }

    setAcpSessionId(id: string) {
        this.acpSessionId = id
        this.setProtocolSessionId(id)
    }

    setState(state: AgentdSessionState, error?: string) {
        if (this.state === state && this.error === error) return
        this.state = state
        this.error = error
        this.updatedAt = Date.now()
        const type: AgentdEventType =
            state === 'completed'
                ? 'completed'
                : state === 'failed'
                  ? 'failed'
                  : state === 'canceled'
                    ? 'canceled'
                    : 'session_state'
        this.events.append(type, { state, ...(error ? { error } : {}) })
        const endedAt = isTerminal(state) ? this.updatedAt : undefined
        this.syncRun({
            state,
            error,
            progress: progressForState(state, error),
            ...(endedAt ? { endedAt } : {})
        })
    }

    appendOutput(text: string) {
        if (!text) return
        this.output = `${this.output}${text}`
        if (this.output.length > this.maxOutputChars) {
            this.output = `…[truncated by Agent Nexus]\n${this.output.slice(
                -this.maxOutputChars
            )}`
        }
        this.updatedAt = Date.now()
        this.syncRun({ output: this.output })
    }

    addArtifact(artifact: AgentdArtifact) {
        const next = structuredClone(artifact)
        const existingIndex = next.id
            ? this.artifacts.findIndex((item) => item.id === next.id)
            : -1
        const retainedBase64Chars = this.artifacts.reduce(
            (total, item, index) =>
                index === existingIndex
                    ? total
                    : total + (item.bytesBase64?.length || 0),
            0
        )
        const binaryChars = next.bytesBase64?.length || 0
        if (
            binaryChars > MAX_ARTIFACT_BASE64_CHARS ||
            retainedBase64Chars + binaryChars > MAX_SESSION_BASE64_CHARS
        ) {
            next.bytesBase64 = undefined
            next.description = [
                next.description,
                `[binary payload omitted: ${binaryChars} base64 characters exceed the session limit]`
            ]
                .filter(Boolean)
                .join('\n')
        }
        if (existingIndex >= 0) {
            this.artifacts[existingIndex] = next
        } else if (this.artifacts.length < MAX_SESSION_ARTIFACTS) {
            this.artifacts.push(next)
        }
        this.updatedAt = Date.now()
        this.syncRun({
            artifacts: this.artifacts.map(runArtifact),
            artifactCount: this.artifacts.length
        })
    }

    setPending(request: AgentdPendingRequest) {
        this.pendingRequest = structuredClone(request)
        this.state = request.kind === 'permission' ? 'permission_required' : 'input_required'
        this.updatedAt = Date.now()
        this.events.append(
            request.kind === 'permission' ? 'permission_required' : 'input_required',
            request
        )
        this.syncRun({
            state: this.state,
            progress: {
                phase: request.kind === 'permission' ? '等待授权' : '等待输入',
                message: clipProgress(request.prompt)
            }
        })
    }

    clearPending() {
        this.pendingRequest = undefined
        this.updatedAt = Date.now()
    }

    emit(type: AgentdEventType, data?: unknown) {
        this.updatedAt = Date.now()
        this.events.append(type, data)
        const progress = progressForEvent(type, data)
        if (progress) this.syncRun({ progress })
    }

    addInputAttachment(
        name: string,
        mediaType: string | undefined,
        bytes: Buffer
    ): AgentdInputAttachmentView {
        if (bytes.length > MAX_INPUT_ATTACHMENT_BYTES) {
            throw new SessionRequestError(413, 'Input attachment is too large')
        }
        const retained = Array.from(this.inputAttachments.values()).reduce(
            (total, attachment) => total + attachment.bytes.length,
            0
        )
        if (this.inputAttachments.size >= MAX_INPUT_ATTACHMENTS) {
            throw new SessionRequestError(413, 'Too many input attachments')
        }
        if (retained + bytes.length > MAX_SESSION_INPUT_BYTES) {
            throw new SessionRequestError(413, 'Session input attachments are too large')
        }
        const id = randomUUID()
        const attachment: AgentdInputAttachment = {
            id,
            name: safeAttachmentName(name) || `attachment-${id.slice(0, 8)}`,
            mediaType: mediaType || undefined,
            bytes: Buffer.from(bytes)
        }
        this.inputAttachments.set(id, attachment)
        this.updatedAt = Date.now()
        return attachmentView(attachment)
    }

    async message(message: string, attachmentIds: string[] = []) {
        if (!this.runtime) throw new SessionRequestError(409, 'Agent runtime is unavailable')
        const attachments = this.inputAttachmentsFor(attachmentIds)
        if (this.pendingRequest) {
            this.syncRun({
                progress: { phase: '继续执行', message: '已提交补充信息' }
            })
            await this.runtime.respondPending(message, attachments)
            return
        }
        if (this.state === 'running') {
            throw new SessionRequestError(409, 'Session is already processing a message')
        }
        this.output = ''
        this.artifacts = []
        this.error = undefined
        this.updatedAt = Date.now()
        this.currentRunId = this.runStore?.create({
            sessionId: this.id,
            agentId: this.agentId,
            agentName: this.agentName,
            protocol: this.protocol,
            workspace: this.workspace,
            protocolSessionId: this.protocolSessionId,
            ownerKeyId: this.ownerKeyId,
            task: message,
            inputAttachmentCount: attachments.length
        }).id
        void this.runtime.prompt(message, attachments).catch((error) => {
            if (this.state !== 'canceled') this.setState('failed', errorMessage(error))
        })
    }

    async cancel() {
        await this.runtime?.cancel()
    }

    async dispose() {
        await this.runtime?.dispose()
        this.inputAttachments.clear()
    }

    snapshot(): AgentdSessionView {
        return {
            id: this.id,
            runId: this.currentRunId,
            protocol: this.protocol,
            protocolSessionId: this.protocolSessionId,
            acpSessionId: this.protocol === 'acp' ? this.acpSessionId : undefined,
            agentId: this.agentId,
            workspace: this.workspace,
            state: this.state,
            output: this.output || undefined,
            error: this.error,
            artifacts: structuredClone(this.artifacts),
            inputAttachments: Array.from(this.inputAttachments.values()).map(attachmentView),
            pendingRequest: this.pendingRequest
                ? structuredClone(this.pendingRequest)
                : undefined,
            lastEventId: this.events.lastId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        }
    }

    interruptForShutdown() {
        if (isActive(this.state)) {
            this.setState('failed', 'Gateway stopped before the task finished')
        }
    }

    private currentRunId?: string

    private syncRun(patch: Parameters<RunStore['update']>[1]) {
        if (!this.runStore || !this.currentRunId) return
        this.runStore.update(this.currentRunId, {
            protocolSessionId: this.protocolSessionId,
            output: this.output || undefined,
            artifacts: this.artifacts.map(runArtifact),
            artifactCount: this.artifacts.length,
            updatedAt: this.updatedAt,
            ...patch
        })
    }

    private inputAttachmentsFor(ids: string[]) {
        const unique = Array.from(new Set(ids))
        const attachments = unique.map((id) => this.inputAttachments.get(id))
        if (attachments.some((attachment) => !attachment)) {
            throw new SessionRequestError(400, 'Unknown input attachment')
        }
        return attachments as AgentdInputAttachment[]
    }
}

export class SessionManager {
    private sessions = new Map<string, ManagedSession>()
    private cleanupTimer?: NodeJS.Timeout
    private readinessCache?: { expiresAt: number; agents: AgentdAgentView[] }

    constructor(
        private config: AgentdConfig,
        private workspacePolicy: WorkspacePolicy,
        private drivers: Map<string, AgentDriver>,
        private readonly runStore?: RunStore
    ) {}

    reconfigure(
        config: AgentdConfig,
        workspacePolicy: WorkspacePolicy,
        drivers: Map<string, AgentDriver>
    ) {
        this.config = config
        this.workspacePolicy = workspacePolicy
        this.drivers = drivers
        this.readinessCache = undefined
        if (this.cleanupTimer) this.restartCleanup()
    }

    startCleanup() {
        if (this.cleanupTimer) return
        this.restartCleanup()
    }

    async listAgents(agentIds?: Set<string>, force = false): Promise<AgentdAgentView[]> {
        const now = Date.now()
        if (!force && this.readinessCache && this.readinessCache.expiresAt > now) {
            return filterAgents(this.readinessCache.agents, agentIds)
        }
        const agents = await Promise.all(
            Object.entries(this.config.agents).map(async ([id, config]) => {
                if (config.protocol === 'a2a') return probeA2AAgent(id, config)
                if (config.enabled === false) {
                    return {
                        id,
                        name: config.name || id,
                        description: config.description,
                        protocol: 'acp' as const,
                        driver: config.driver,
                        ready: false,
                        enabled: false,
                        workspace: this.defaultWorkspace(id),
                        error: 'Agent is disabled',
                        checkedAt: Date.now()
                    }
                }
                const driver = this.drivers.get(id)
                if (!driver) {
                    return {
                        id,
                        name: config.name || id,
                        description: config.description,
                        protocol: 'acp' as const,
                        driver: config.driver,
                        ready: false,
                        enabled: true,
                        workspace: this.defaultWorkspace(id),
                        error: 'ACP driver is unavailable',
                        checkedAt: Date.now()
                    }
                }
                const startedAt = Date.now()
                try {
                    const probe = await driver.probe()
                    return {
                        ...probe,
                        protocol: 'acp' as const,
                        driver: config.driver,
                        enabled: true,
                        workspace: this.defaultWorkspace(id),
                        checkedAt: Date.now(),
                        responseMs: Date.now() - startedAt
                    }
                } catch (error) {
                    return {
                        id,
                        name: config.name || id,
                        description: config.description,
                        protocol: 'acp' as const,
                        driver: config.driver,
                        ready: false,
                        enabled: true,
                        workspace: this.defaultWorkspace(id),
                        error: errorMessage(error),
                        checkedAt: Date.now(),
                        responseMs: Date.now() - startedAt
                    }
                }
            })
        )
        agents.sort((left, right) => left.name.localeCompare(right.name))
        this.readinessCache = {
            expiresAt: Date.now() + READINESS_CACHE_MS,
            agents: structuredClone(agents)
        }
        return filterAgents(agents, agentIds)
    }

    async create(agentId: string, workspaceInput: string | undefined, ownerKeyId: string) {
        await this.ensureCapacity()
        const config = this.config.agents[agentId]
        if (!config || config.enabled === false) {
            throw new SessionRequestError(404, `Configured agent not found: ${agentId}`)
        }

        let workspace: string | undefined
        let driver: AgentDriver | undefined
        if (config.protocol !== 'a2a') {
            driver = this.drivers.get(agentId)
            if (!driver) {
                throw new SessionRequestError(404, `Configured ACP agent not found: ${agentId}`)
            }
            const requestedWorkspace =
                String(workspaceInput || '').trim() || this.defaultWorkspace(agentId)
            if (!requestedWorkspace) {
                throw new SessionRequestError(400, `Configured ACP agent has no workspace: ${agentId}`)
            }
            workspace = await this.workspacePolicy.resolve(requestedWorkspace)
        }
        const session = new ManagedSession(
            agentId,
            config.protocol === 'a2a' ? 'a2a' : 'acp',
            workspace,
            ownerKeyId,
            this.config.maxEventsPerSession,
            this.config.maxOutputChars,
            config.name || agentId,
            this.runStore
        )
        const runtime: AgentSessionRuntime =
            config.protocol === 'a2a'
                ? new A2AClientRuntime(
                config,
                session,
                this.config.promptTimeoutMs || 30 * 60_000
            )
                : new AcpProcessRuntime(
                      driver!,
                      session,
                      this.config.maxOutputChars,
                      this.config.promptTimeoutMs || 30 * 60_000
                  )
        this.sessions.set(session.id, session)
        session.attach(runtime)
        try {
            await runtime.start(workspace)
            return session.snapshot()
        } catch (error) {
            session.setState('failed', errorMessage(error))
            await session.dispose()
            this.sessions.delete(session.id)
            throw new SessionRequestError(502, `Agent failed to start: ${errorMessage(error)}`)
        }
    }

    get(id: string) {
        return this.require(id).snapshot()
    }

    owns(id: string, keyId: string) {
        return this.require(id).ownerKeyId === keyId
    }

    count() {
        return this.sessions.size
    }

    listRuns(query: RunListQuery = {}) {
        return this.runStore?.list(query) || { runs: [], total: 0 }
    }

    getRun(id: string) {
        const run = this.runStore?.get(id)
        if (!run) throw new RunNotFoundError(id)
        return run
    }

    async message(id: string, message: string, attachmentIds: string[] = []) {
        const text = String(message || '')
        if (!text.trim()) throw new SessionRequestError(400, 'message is required')
        const session = this.require(id)
        await session.message(text, attachmentIds)
        return session.snapshot()
    }

    addInputAttachment(
        id: string,
        name: string,
        mediaType: string | undefined,
        bytes: Buffer
    ) {
        const session = this.require(id)
        return session.addInputAttachment(name, mediaType, bytes)
    }

    async cancel(id: string) {
        const session = this.require(id)
        await session.cancel()
        return session.snapshot()
    }

    eventsAfter(id: string, after?: string) {
        return this.require(id).events.after(after)
    }

    subscribe(id: string, listener: (event: AgentdEvent) => void) {
        return this.require(id).events.subscribe(listener)
    }

    async shutdown() {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
        this.cleanupTimer = undefined
        await Promise.allSettled(
            Array.from(this.sessions.values()).map(async (session) => {
                session.interruptForShutdown()
                await session.dispose()
            })
        )
        this.sessions.clear()
    }

    private require(id: string) {
        const session = this.sessions.get(id)
        if (!session) throw new SessionNotFoundError(id)
        return session
    }

    private async ensureCapacity() {
        const limit = this.config.maxSessions || 64
        if (this.sessions.size < limit) return
        const terminal = Array.from(this.sessions.values())
            .filter((session) => isTerminal(session.state))
            .sort((left, right) => left.updatedAt - right.updatedAt)
        while (this.sessions.size >= limit && terminal.length) {
            const session = terminal.shift()!
            await session.dispose()
            this.sessions.delete(session.id)
        }
        if (this.sessions.size >= limit) {
            throw new SessionRequestError(429, 'Session capacity has been reached')
        }
    }

    private async cleanup() {
        const cutoff = Date.now() - this.config.sessionTtlMs
        for (const [id, session] of this.sessions) {
            if (session.updatedAt > cutoff) continue
            if (!isTerminal(session.state)) {
                session.setState('failed', 'Session expired after exceeding its lifetime')
            }
            await session.dispose()
            this.sessions.delete(id)
        }
    }

    private restartCleanup() {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
        this.cleanupTimer = setInterval(
            () => void this.cleanup(),
            this.config.cleanupIntervalMs || 60_000
        )
        this.cleanupTimer.unref?.()
    }

    private defaultWorkspace(agentId: string) {
        const config = this.config.agents[agentId]
        if (config?.protocol === 'a2a') return ''
        return config?.workspace || this.config.workspaceRoots[0] || ''
    }
}

function progressForState(
    state: AgentdSessionState,
    error?: string
): AgentdRunProgress {
    const phases: Record<AgentdSessionState, string> = {
        created: '已创建',
        running: '运行中',
        input_required: '等待输入',
        permission_required: '等待授权',
        completed: '已完成',
        failed: '失败',
        canceled: '已取消'
    }
    return { phase: phases[state], message: error ? clipProgress(error) : undefined }
}

function progressForEvent(
    type: AgentdEventType,
    data: unknown
): AgentdRunProgress | undefined {
    const record = isRecord(data) ? data : undefined
    const message = clipProgress(
        firstString(record?.title, record?.name, record?.status, record?.toolCallId)
    )
    const percent = finitePercent(record?.percent)
    switch (type) {
        case 'assistant_chunk':
            return { phase: '生成回复' }
        case 'thought_chunk':
            return { phase: '分析任务' }
        case 'plan':
            return { phase: '制定计划', message, percent }
        case 'tool_call':
            return { phase: '调用工具', message, percent }
        case 'tool_update':
            return { phase: '执行工具', message, percent }
        case 'terminal_output':
            return { phase: '执行命令', message }
        case 'file_activity':
            return { phase: '处理文件', message }
        case 'artifact':
            return { phase: '生成产物', message }
        default:
            return undefined
    }
}

function runArtifact(artifact: AgentdArtifact) {
    return {
        id: artifact.id,
        name: artifact.name,
        description: artifact.description,
        url: artifact.url,
        filename: artifact.filename,
        mediaType: artifact.mediaType,
        metadata: artifact.metadata ? structuredClone(artifact.metadata) : undefined
    }
}

function firstString(...values: unknown[]) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
}

function clipProgress(value: string | undefined) {
    if (!value) return undefined
    return value.length > 500 ? `${value.slice(0, 500)}…` : value
}

function finitePercent(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
        ? value
        : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export class SessionNotFoundError extends Error {
    constructor(readonly sessionId: string) {
        super(`Agent Nexus session not found: ${sessionId}`)
    }
}

export class SessionRequestError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

export class RunNotFoundError extends Error {
    constructor(readonly runId: string) {
        super(`Agent Nexus run not found: ${runId}`)
    }
}

function filterAgents(agents: AgentdAgentView[], ids?: Set<string>) {
    return agents
        .filter((agent) => !ids || ids.has(agent.id))
        .map((agent) => structuredClone(agent))
}

function isTerminal(state: AgentdSessionState) {
    return state === 'completed' || state === 'failed' || state === 'canceled'
}

function isActive(state: AgentdSessionState) {
    return state === 'running' || state === 'input_required' || state === 'permission_required'
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function attachmentView(attachment: AgentdInputAttachment): AgentdInputAttachmentView {
    return {
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        size: attachment.bytes.length
    }
}

function safeAttachmentName(value: string) {
    return String(value || '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
        .slice(0, 180)
}
