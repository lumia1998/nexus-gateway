import { randomUUID } from 'node:crypto'
import type { AgentDriver } from './drivers/index.js'
import type { WorkspacePolicy } from './workspace.js'
import { SessionEventLog } from './events.js'
import { AcpProcessRuntime } from './acp/runtime.js'
import type { AcpSessionSink } from './session-contract.js'
import type {
    AgentdAgentView,
    AgentdArtifact,
    AgentdConfig,
    AgentdEvent,
    AgentdEventType,
    AgentdPendingRequest,
    AgentdSessionState,
    AgentdSessionView
} from './types.js'

const MAX_SESSION_ARTIFACTS = 64
const MAX_ARTIFACT_BASE64_CHARS = 16 * 1024 * 1024
const MAX_SESSION_BASE64_CHARS = 32 * 1024 * 1024

class ManagedSession implements AcpSessionSink {
    readonly id = randomUUID()
    readonly createdAt = Date.now()
    readonly events: SessionEventLog
    state: AgentdSessionState = 'created'
    updatedAt = this.createdAt
    acpSessionId?: string
    output = ''
    error?: string
    pendingRequest?: AgentdPendingRequest
    private artifacts: AgentdArtifact[] = []
    private runtime?: AcpProcessRuntime

    constructor(
        readonly agentId: string,
        readonly workspace: string,
        maxEvents: number,
        private readonly maxOutputChars: number
    ) {
        this.events = new SessionEventLog(this.id, maxEvents)
        this.events.append('session_state', { state: this.state })
    }

    attach(runtime: AcpProcessRuntime) {
        this.runtime = runtime
    }

    setAcpSessionId(id: string) {
        this.acpSessionId = id
        this.updatedAt = Date.now()
    }

    setState(state: AgentdSessionState, error?: string) {
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
    }

    appendOutput(text: string) {
        if (!text) return
        this.output = `${this.output}${text}`
        if (this.output.length > this.maxOutputChars) {
            this.output = `…[truncated by nexus-agentd]\n${this.output.slice(
                -this.maxOutputChars
            )}`
        }
        this.updatedAt = Date.now()
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
    }

    setPending(request: AgentdPendingRequest) {
        this.pendingRequest = structuredClone(request)
        this.state = request.kind === 'permission' ? 'permission_required' : 'input_required'
        this.updatedAt = Date.now()
        this.events.append(
            request.kind === 'permission'
                ? 'permission_required'
                : 'input_required',
            request
        )
    }

    clearPending() {
        this.pendingRequest = undefined
        this.updatedAt = Date.now()
    }

    emit(type: AgentdEventType, data?: unknown) {
        this.updatedAt = Date.now()
        this.events.append(type, data)
    }

    async message(message: string) {
        if (!this.runtime) throw new Error('ACP runtime is unavailable')
        if (this.pendingRequest) {
            await this.runtime.respondPending(message)
            return
        }
        if (this.state === 'running') {
            throw new Error('ACP session is already processing a prompt')
        }
        this.output = ''
        this.artifacts = []
        this.error = undefined
        this.updatedAt = Date.now()
        void this.runtime.prompt(message).catch((error) => {
            if (this.state !== 'canceled') this.setState('failed', errorMessage(error))
        })
    }

    async cancel() {
        await this.runtime?.cancel()
    }

    async dispose() {
        await this.runtime?.dispose()
    }

    snapshot(): AgentdSessionView {
        return {
            id: this.id,
            acpSessionId: this.acpSessionId,
            agentId: this.agentId,
            workspace: this.workspace,
            state: this.state,
            output: this.output || undefined,
            error: this.error,
            artifacts: structuredClone(this.artifacts),
            pendingRequest: this.pendingRequest
                ? structuredClone(this.pendingRequest)
                : undefined,
            lastEventId: this.events.lastId,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt
        }
    }
}

export class SessionManager {
    private sessions = new Map<string, ManagedSession>()
    private cleanupTimer?: NodeJS.Timeout

    constructor(
        private config: AgentdConfig,
        private workspacePolicy: WorkspacePolicy,
        private drivers: Map<string, AgentDriver>
    ) {}

    reconfigure(
        config: AgentdConfig,
        workspacePolicy: WorkspacePolicy,
        drivers: Map<string, AgentDriver>
    ) {
        this.config = config
        this.workspacePolicy = workspacePolicy
        this.drivers = drivers
    }

    startCleanup() {
        if (this.cleanupTimer) return
        this.cleanupTimer = setInterval(() => void this.cleanup(), 60_000)
        this.cleanupTimer.unref?.()
    }

    async listAgents(): Promise<AgentdAgentView[]> {
        return Promise.all(
            Array.from(this.drivers.entries()).map(async ([id, driver]) => ({
                ...(await driver.probe()),
                enabled: true,
                workspace: this.defaultWorkspace(id)
            }))
        )
    }

    async create(agentId: string, workspaceInput?: string) {
        const driver = this.drivers.get(agentId)
        if (!driver) throw new Error(`Configured ACP agent not found: ${agentId}`)
        const requestedWorkspace =
            String(workspaceInput || '').trim() || this.defaultWorkspace(agentId)
        if (!requestedWorkspace) {
            throw new Error(`Configured ACP agent has no workspace: ${agentId}`)
        }
        const workspace = await this.workspacePolicy.resolve(requestedWorkspace)
        const session = new ManagedSession(
            agentId,
            workspace,
            this.config.maxEventsPerSession,
            this.config.maxOutputChars
        )
        this.sessions.set(session.id, session)
        const runtime = new AcpProcessRuntime(
            driver,
            session,
            this.config.maxOutputChars
        )
        session.attach(runtime)
        try {
            await runtime.start(workspace)
            return session.snapshot()
        } catch (error) {
            session.setState('failed', errorMessage(error))
            await session.dispose()
            throw error
        }
    }

    get(id: string) {
        return this.require(id).snapshot()
    }

    async message(id: string, message: string) {
        const text = String(message || '')
        if (!text.trim()) throw new Error('message is required')
        const session = this.require(id)
        await session.message(text)
        return session.snapshot()
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
            Array.from(this.sessions.values()).map((session) => session.dispose())
        )
        this.sessions.clear()
    }

    private require(id: string) {
        const session = this.sessions.get(id)
        if (!session) throw new SessionNotFoundError(id)
        return session
    }

    private async cleanup() {
        const cutoff = Date.now() - this.config.sessionTtlMs
        for (const [id, session] of this.sessions) {
            if (
                session.updatedAt > cutoff ||
                session.state === 'running' ||
                session.state === 'permission_required' ||
                session.state === 'input_required'
            ) {
                continue
            }
            await session.dispose()
            this.sessions.delete(id)
        }
    }

    private defaultWorkspace(agentId: string) {
        return this.config.agents[agentId]?.workspace || this.config.workspaceRoots[0] || ''
    }
}

export class SessionNotFoundError extends Error {
    constructor(readonly sessionId: string) {
        super(`Nexus Gateway session not found: ${sessionId}`)
    }
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
