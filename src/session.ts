import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { extname } from 'node:path'
import { AcpProcessRuntime } from './acp/runtime.js'
import { A2AClientRuntime } from './a2a/runtime.js'
import type { AgentDriver } from './drivers/index.js'
import { SessionEventLog } from './events.js'
import { RunStore, type RunListQuery, type RunArtifactQuery } from './run-store.js'
import {
    AdminRunManager,
    type AdminRetryReservation,
    type AdminRetryReservationFactory,
    type AdminRunOperationResult,
    type AdminRunControls
} from './session/admin-runs.js'
import { SessionAdmission } from './session/admission.js'
import { SessionReadiness } from './session/readiness.js'
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
    AgentdPendingResponse,
    AgentdProtocol,
    AgentdRunProgress,
    AgentdSessionState,
    AgentdSessionView,
    AgentdTurnCompletion,
    AgentdTurnCompletionProof
} from './types.js'
import {
    ContainedReadError,
    readContainedFile,
    type WorkspacePolicy
} from './workspace.js'

const MAX_SESSION_ARTIFACTS = 64
const MAX_ARTIFACT_BASE64_CHARS = 16 * 1024 * 1024
const MAX_SESSION_BASE64_CHARS = 32 * 1024 * 1024
const MAX_INPUT_ATTACHMENTS = 16
const MAX_INPUT_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_SESSION_INPUT_BYTES = 32 * 1024 * 1024
const MAX_PUBLISHED_FILE_BYTES = 12 * 1024 * 1024

/** Optional durable sink for full artifact snapshots. */
export interface SessionArtifactStore {
    recordArtifacts(
        runId: string,
        artifacts: AgentdArtifact[]
    ): unknown | Promise<unknown>
}

export type SessionLifecycleEvent =
    | {
          type: 'session_created'
          sessionId: string
          ownerKeyId: string
          agentId: string
      }
    | {
          type: 'run_updated'
          sessionId: string
          runId: string
          ownerKeyId: string
          state: AgentdSessionState
      }
    | {
          type: 'session_closed'
          sessionId: string
          ownerKeyId: string
          agentId: string
      }

export type SessionLifecycleListener = (event: SessionLifecycleEvent) => void

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
    private completion?: AgentdTurnCompletion
    private artifacts: AgentdArtifact[] = []
    private inputAttachments = new Map<string, AgentdInputAttachment>()
    private runtime?: AgentSessionRuntime
    private readonly artifactStore?: SessionArtifactStore
    private readonly onRunUpdate?: (
        runId: string,
        state: AgentdSessionState
    ) => void

    constructor(
        readonly agentId: string,
        readonly protocol: AgentdProtocol,
        readonly workspace: string | undefined,
        readonly ownerKeyId: string,
        maxEvents: number,
        private readonly maxOutputChars: number,
        private readonly agentName: string,
        private readonly runStore?: RunStore,
        readonly instanceId: string = randomUUID(),
        artifactStore?: SessionArtifactStore,
        onRunUpdate?: (runId: string, state: AgentdSessionState) => void
    ) {
        this.artifactStore = artifactStore || runStore
        this.onRunUpdate = onRunUpdate
        this.events = new SessionEventLog(this.id, maxEvents)
        this.events.append('session_state', { state: this.state, protocol })
    }

    attach(runtime: AgentSessionRuntime) {
        this.runtime = runtime
    }

    runtimeAvailable() {
        return Boolean(this.runtime && this.runtime.isAvailable?.() !== false)
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
        if (state !== 'completed') this.completion = undefined
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
        this.events.append(type, {
            state,
            ...(error ? { error } : {}),
            ...(state === 'completed' && this.completion
                ? { completion: structuredClone(this.completion) }
                : {})
        })
        const endedAt = isTerminal(state) ? this.updatedAt : undefined
        this.syncRun({
            state,
            error,
            progress: progressForState(state, error),
            completion:
                state === 'completed' && this.completion
                    ? structuredClone(this.completion)
                    : undefined,
            ...(endedAt ? { endedAt } : {})
        })
    }

    completeTurn(proof: AgentdTurnCompletionProof) {
        if (this.pendingRequest || isInteractive(this.state)) {
            this.emit('terminal_output', {
                stream: 'system',
                text: `Ignored ${proof.source} completion while the session is waiting for ${this.pendingRequest?.kind || 'input'}.`
            })
            return false
        }
        if (this.state !== 'running') return false

        const outputPresent = this.output.trim().length > 0
        const artifactCount = this.artifacts.length
        if (!outputPresent && artifactCount < 1) {
            this.setState(
                'failed',
                `Agent ended the turn (${proof.stopReason}) without a final response or artifact.`
            )
            return false
        }

        this.completion = {
            ...structuredClone(proof),
            runId: this.currentRunId,
            protocol: this.protocol,
            verified: true,
            outputPresent,
            artifactCount,
            completedAt: Date.now()
        }
        this.setState('completed')
        return true
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

    replaceOutput(text: string) {
        this.output = String(text || '').slice(0, this.maxOutputChars)
        this.updatedAt = Date.now()
        this.syncRun({ output: this.output || undefined })
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

    async publishFile(filePath: string) {
        return (await this.publishFiles([filePath]))[0]
    }

    async publishFiles(filePaths: string[]) {
        const requested = filePaths
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        if (!requested.length) {
            throw new SessionRequestError(400, 'path is required')
        }
        if (requested.length > 32) {
            throw new SessionRequestError(400, 'A single publish request accepts at most 32 files')
        }
        if (!this.workspace) {
            throw new SessionRequestError(
                400,
                'This session does not have a local workspace'
            )
        }
        const seen = new Set<string>()
        const artifacts: AgentdArtifact[] = []
        for (const requestedPath of requested) {
            if (seen.has(requestedPath)) continue
            seen.add(requestedPath)
            artifacts.push(await this.publishSingleFile(requestedPath))
        }
        return artifacts
    }

    private async publishSingleFile(requestedPath: string) {
        try {
            const workspaceRoot = await realpath(this.workspace!)
            const file = await readContainedFile([workspaceRoot], requestedPath, {
                maxBytes: MAX_PUBLISHED_FILE_BYTES
            })
            const artifact: AgentdArtifact = {
                id: `published:${randomUUID()}`,
                name: file.filename,
                filename: file.filename,
                mediaType: mediaTypeForPath(file.filename),
                bytesBase64: file.bytes.toString('base64'),
                metadata: {
                    source: 'workspace_publish',
                    path: file.relative,
                    size: file.size
                }
            }
            this.addArtifact(artifact)
            this.emit('artifact', runArtifact(artifact))
            return artifact
        } catch (error) {
            if (error instanceof SessionRequestError) throw error
            if (error instanceof ContainedReadError) throw publishFailure(error)
            const code = (error as NodeJS.ErrnoException)?.code
            if (code === 'ENOENT') {
                throw new SessionRequestError(404, 'Published file was not found')
            }
            if (code === 'EACCES' || code === 'EPERM') {
                throw new SessionRequestError(403, 'Published file cannot be read')
            }
            throw error
        }
    }

    setPending(request: AgentdPendingRequest) {
        this.completion = undefined
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

    async message(
        message: string,
        attachmentIds: string[] = [],
        retryOfRunId?: string
    ) {
        if (!this.runtime || this.runtime.isAvailable?.() === false) throw new SessionRequestError(409, 'Agent runtime is unavailable')
        const attachments = this.inputAttachmentsFor(attachmentIds)
        if (this.pendingRequest) {
            await this.resolvePending(
                {
                    requestId: this.pendingRequest.id,
                    message
                },
                attachmentIds
            )
            return
        }
        if (this.state === 'running') {
            throw new SessionRequestError(409, 'Session is already processing a message')
        }
        this.output = ''
        this.artifacts = []
        this.completion = undefined
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
            inputAttachmentCount: attachments.length,
            ...(retryOfRunId ? { retryOfRunId } : {})
        }).id
        this.setState('running')
        void this.runtime.prompt(message, attachments).catch((error) => {
            if (this.state !== 'canceled') this.setState('failed', errorMessage(error))
        })
    }

    async resolvePending(
        response: AgentdPendingResponse,
        attachmentIds: string[] = []
    ) {
        if (!this.runtime || this.runtime.isAvailable?.() === false) {
            throw new SessionRequestError(409, 'Agent runtime is unavailable')
        }
        const pending = this.pendingRequest
        if (!pending) {
            throw new SessionRequestError(409, 'Session is not waiting for input')
        }
        if (pending.id !== response.requestId) {
            throw new SessionRequestError(
                409,
                `Pending request no longer matches: ${response.requestId}`
            )
        }
        const attachments = this.inputAttachmentsFor(attachmentIds)
        this.syncRun({
            progress: { phase: '继续执行', message: '已提交补充信息' }
        })
        await this.runtime.respondPending(response, attachments)
    }

    async cancel() {
        const runtime = this.runtime
        this.runtime = undefined
        this.clearPending()
        this.setState('canceled')
        try { await runtime?.cancel() } finally {
            try { await runtime?.dispose() } finally { this.inputAttachments.clear() }
        }
    }

    async dispose() {
        const runtime = this.runtime
        this.runtime = undefined
        try { await runtime?.dispose() } finally { this.inputAttachments.clear() }
    }

    snapshot(): AgentdSessionView {
        return {
            id: this.id,
            instanceId: this.instanceId,
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
            completion: this.completion
                ? structuredClone(this.completion)
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
            completion: this.completion
                ? structuredClone(this.completion)
                : undefined,
            updatedAt: this.updatedAt,
            ...patch
        })
        if (patch.artifacts && this.artifactStore?.recordArtifacts) {
            const runId = this.currentRunId
            const artifacts = structuredClone(this.artifacts)
            void Promise.resolve()
                .then(() =>
                    this.artifactStore!.recordArtifacts(
                        runId!,
                        artifacts
                    )
                )
                .catch((error) => {
                    console.error(
                        JSON.stringify({
                            level: 'error',
                            event: 'artifact_snapshot_record_failed',
                            runId,
                            message: errorMessage(error)
                        })
                    )
                })
        }
        try {
            this.onRunUpdate?.(this.currentRunId, this.state)
        } catch (error) {
            // Lifecycle observers (for example quota accounting) must never
            // turn a successful agent event into a failed protocol turn.
            console.error(
                JSON.stringify({
                    level: 'error',
                    event: 'session_lifecycle_observer_failed',
                    sessionId: this.id,
                    runId: this.currentRunId,
                    message: errorMessage(error)
                })
            )
        }
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
    readonly instanceId = randomUUID()
    private sessions = new Map<string, ManagedSession>()
    private sessionLocks = new Map<string, Promise<unknown>>()
    private cleanupTimer?: NodeJS.Timeout
    private readonly readiness: SessionReadiness
    private readonly admission: SessionAdmission
    private readonly adminRuns: AdminRunManager
    private readonly artifactStore?: SessionArtifactStore
    private readonly lifecycleListeners = new Set<SessionLifecycleListener>()

    constructor(
        private config: AgentdConfig,
        private workspacePolicy: WorkspacePolicy,
        private drivers: Map<string, AgentDriver>,
        private readonly runStore?: RunStore,
        artifactStore?: SessionArtifactStore
    ) {
        this.artifactStore = artifactStore || runStore
        this.readiness = new SessionReadiness(config, drivers, {
            requestError: (status, message) => new SessionRequestError(status, message)
        })
        this.admission = new SessionAdmission({
            maxSessions: () => this.config.maxSessions || 64,
            sessionCount: () => this.sessions.size,
            sessions: () => this.sessions.values(),
            isCurrent: (session) => this.sessions.get(session.id) === session,
            withSessionLock: (id, operation) => this.withSessionLock(id, operation),
            removeSession: (id) => {
                const session = this.sessions.get(id)
                if (!session || !this.sessions.delete(id)) return
                this.notifyLifecycle({
                    type: 'session_closed',
                    sessionId: session.id,
                    ownerKeyId: session.ownerKeyId,
                    agentId: session.agentId
                })
            },
            requestError: (status, message) => new SessionRequestError(status, message)
        })
        this.adminRuns = new AdminRunManager({
            getRun: (runId) => this.getRun(runId),
            getSession: (sessionId) => this.sessions.get(sessionId),
            getAgent: (agentId) => this.config.agents[agentId],
            getOwnerKeyId: (runId) => this.getRunOwnerKeyId(runId),
            withSessionLock: (sessionId, operation) => this.withSessionLock(sessionId, operation),
            startRetry: async (run, ownerKeyId, reservation) => {
                const created = await this.create(run.agentId, run.workspace, ownerKeyId)
                try {
                    reservation?.bind(created.id)
                    await this.message(created.id, run.task, [], run.id)
                    const snapshot = this.get(created.id)
                    if (!snapshot.runId) {
                        throw new SessionRequestError(
                            502,
                            'Retried task did not create a run record'
                        )
                    }
                    return { runId: snapshot.runId, sessionId: created.id }
                } catch (error) {
                    try {
                        await this.close(created.id)
                    } catch (cleanupError) {
                        console.error(
                            JSON.stringify({
                                level: 'error',
                                event: 'retry_session_cleanup_failed',
                                sessionId: created.id,
                                message: errorMessage(cleanupError)
                            })
                        )
                    }
                    throw error
                }
            },
            markRetryOf: (newRunId, oldRunId) => {
                const store = this.runStore as
                    | (RunStore & {
                          setRetryOfRunId?: (
                              newRunId: string,
                              oldRunId: string
                          ) => unknown
                      })
                    | undefined
                return store?.setRetryOfRunId?.(newRunId, oldRunId)
            },
            requestError: (status, message) => new SessionRequestError(status, message)
        })
    }

    reconfigure(
        config: AgentdConfig,
        workspacePolicy: WorkspacePolicy,
        drivers: Map<string, AgentDriver>
    ) {
        this.config = config
        this.workspacePolicy = workspacePolicy
        this.drivers = drivers
        this.readiness.reconfigure(config, drivers)
        if (this.cleanupTimer) this.restartCleanup()
    }

    startCleanup() {
        if (this.cleanupTimer) return
        this.restartCleanup()
    }

    async listAgents(agentIds?: Set<string>, force = false): Promise<AgentdAgentView[]> {
        return this.readiness.listAgents(agentIds, force)
    }

    async create(agentId: string, workspaceInput: string | undefined, ownerKeyId: string) {
        if (!Object.hasOwn(this.config.agents, agentId) || this.config.agents[agentId].enabled === false) {
            throw new SessionRequestError(404, `Configured agent not found: ${agentId}`)
        }
        let release: () => void = () => undefined
        await this.withSessionLock('admission', async () => {
            release = await this.admission.reserve()
        })
        try { return await this.createReserved(agentId, workspaceInput, ownerKeyId, release) }
        finally { release() }
    }

    private async createReserved(agentId: string, workspaceInput: string | undefined, ownerKeyId: string, release: () => void) {
        const config = Object.hasOwn(this.config.agents, agentId) ? this.config.agents[agentId] : undefined
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
        if (this.admission.isClosing()) {
            throw new SessionRequestError(503, 'Gateway is shutting down')
        }
        const session = new ManagedSession(
            agentId,
            config.protocol === 'a2a' ? 'a2a' : 'acp',
            workspace,
            ownerKeyId,
            this.config.maxEventsPerSession,
            this.config.maxOutputChars,
            config.name || agentId,
            this.runStore,
            this.instanceId,
            this.artifactStore,
            (runId, state) =>
                this.notifyLifecycle({
                    type: 'run_updated',
                    sessionId: session.id,
                    runId,
                    ownerKeyId: session.ownerKeyId,
                    state
                })
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
                      this.config.promptTimeoutMs || 30 * 60_000,
                      this.workspacePolicy.listRoots()
                  )
        this.sessions.set(session.id, session)
        this.notifyLifecycle({
            type: 'session_created',
            sessionId: session.id,
            ownerKeyId: session.ownerKeyId,
            agentId: session.agentId
        })
        release()
        session.attach(runtime)
        try {
            await runtime.start(workspace)
            return session.snapshot()
        } catch (error) {
            session.setState('failed', errorMessage(error))
            try { await session.dispose() } catch (cleanupError) {
                console.error(JSON.stringify({ level: 'error', event: 'session_start_cleanup_failed', sessionId: session.id, message: errorMessage(cleanupError) }))
            } finally {
                if (this.sessions.delete(session.id)) {
                    this.notifyLifecycle({
                        type: 'session_closed',
                        sessionId: session.id,
                        ownerKeyId: session.ownerKeyId,
                        agentId: session.agentId
                    })
                }
            }
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

    subscribeLifecycle(listener: SessionLifecycleListener) {
        this.lifecycleListeners.add(listener)
        return () => this.lifecycleListeners.delete(listener)
    }

    listRuns(query: RunListQuery = {}) {
        return this.runStore?.list(query) || { runs: [], total: 0, stats: { active: 0, completed: 0, failed: 0 } }
    }

    getRun(id: string) {
        const run = this.runStore?.get(id)
        if (!run) throw new RunNotFoundError(id)
        return run
    }

    getRunOwnerKeyId(id: string) {
        const store = this.runStore as
            | (RunStore & {
                  getOwnerKeyId?: (runId: string) => string | undefined
              })
            | undefined
        return store?.getOwnerKeyId?.(id)
    }

    deleteRun(id: string) {
        const store = this.runStore as
            | (RunStore & {
                  deleteRun?: (runId: string) => unknown
              })
            | undefined
        return store?.deleteRun?.(id)
    }

    ownsRun(id: string, keyId: string) {
        return this.getRunOwnerKeyId(id) === keyId
    }

    getRunArtifacts(id: string) {
        return this.getRun(id).artifacts
    }

    listArtifacts(query: RunArtifactQuery = {}) {
        const store = this.runStore as
            | (RunStore & { listArtifacts?: (q: RunArtifactQuery) => unknown })
            | undefined
        return store?.listArtifacts?.(query) || { artifacts: [], total: 0 }
    }

    async removeRunArtifact(runId: string, artifactId: string) {
        const store = this.runStore as
            | (RunStore & { removeArtifact?: (runId: string, artifactId: string) => Promise<unknown> | unknown })
            | undefined
        return store?.removeArtifact?.(runId, artifactId)
    }

    getStorageMetrics(): ReturnType<RunStore['metrics']> | undefined {
        return this.runStore?.metrics()
    }

    async readRunArtifact(runId: string, artifactId: string) {
        // Read through RunStore so the artifact directory remains the only
        // place that knows how payload filenames are derived and validated.
        this.getRun(runId)
        const store = this.runStore as
            | (RunStore & {
                  readArtifact?: (
                      runId: string,
                      artifactId: string
                  ) => Promise<unknown> | unknown
              })
            | undefined
        return store?.readArtifact?.(runId, artifactId)
    }

    getRunArtifact(runId: string, artifactId: string) {
        return this.readRunArtifact(runId, artifactId)
    }

    getRunControls(id: string): AdminRunControls {
        return this.adminRuns.getRunControls(id)
    }

    async cancelRun(id: string): Promise<AdminRunOperationResult> {
        return this.adminRuns.cancelRun(id)
    }

    async respondRun(
        id: string,
        response: AgentdPendingResponse,
        attachmentIds: string[] = []
    ): Promise<AdminRunOperationResult> {
        return this.adminRuns.respondRun(id, response, attachmentIds)
    }

    async retryRun(
        id: string,
        reserveRetry?: AdminRetryReservationFactory
    ): Promise<AdminRunOperationResult> {
        return this.adminRuns.retryRun(id, reserveRetry)
    }

    retryOfRunId(id: string) {
        return this.adminRuns.retryOfRunId(id)
    }

    async message(
        id: string,
        message: string,
        attachmentIds: string[] = [],
        retryOfRunId?: string
    ) {
        const text = String(message || '')
        if (!text.trim()) throw new SessionRequestError(400, 'message is required')
        return this.withSessionLock(id, async () => {
            const session = this.require(id)
            await session.message(text, attachmentIds, retryOfRunId)
            return session.snapshot()
        })
    }

    async resolvePending(
        id: string,
        response: AgentdPendingResponse,
        attachmentIds: string[] = []
    ) {
        return this.withSessionLock(id, async () => {
            const session = this.require(id)
            await session.resolvePending(response, attachmentIds)
            return session.snapshot()
        })
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

    async publishFile(id: string, paths: string[]) {
        return this.withSessionLock(id, async () => {
            const session = this.require(id)
            const artifacts = await session.publishFiles(paths)
            return { session: session.snapshot(), artifacts }
        })
    }

    async cancel(id: string) {
        return this.withSessionLock(id, async () => {
            const session = this.require(id)
            await session.cancel()
            return session.snapshot()
        })
    }

    async close(id: string) {
        return this.withSessionLock(id, async () => {
            const session = this.require(id)
            if (isActive(session.state)) await session.cancel()
            const snapshot = session.snapshot()
            await session.dispose()
            if (this.sessions.delete(id)) {
                this.notifyLifecycle({
                    type: 'session_closed',
                    sessionId: session.id,
                    ownerKeyId: session.ownerKeyId,
                    agentId: session.agentId
                })
            }
            return snapshot
        })
    }

    eventsAfter(id: string, after?: string) {
        return this.require(id).events.after(after)
    }

    eventReplay(id: string, after?: string) {
        return this.require(id).events.replay(after)
    }

    subscribe(id: string, listener: (event: AgentdEvent) => void) {
        return this.require(id).events.subscribe(listener)
    }

    async shutdown() {
        this.admission.markClosing()
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
        this.cleanupTimer = undefined
        const results = await Promise.allSettled(
            Array.from(this.sessions.values()).map(async (session) => {
                session.interruptForShutdown()
                await session.dispose()
            })
        )
        for (const session of this.sessions.values()) {
            this.notifyLifecycle({
                type: 'session_closed',
                sessionId: session.id,
                ownerKeyId: session.ownerKeyId,
                agentId: session.agentId
            })
        }
        this.sessions.clear()
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Failed to dispose one or more Agent sessions')
    }

    private async withSessionLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
        // Serialise mutating operations per session so that concurrent
        // message / resolvePending / cancel / close / publish requests cannot
        // observe half-updated state (e.g. artifacts reset in the middle of
        // publishFile).
        const previous = this.sessionLocks.get(id) || Promise.resolve()
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const tail = previous.then(() => gate)
        this.sessionLocks.set(id, tail)
        try {
            await previous
            return await operation()
        } finally {
            release()
            if (this.sessionLocks.get(id) === tail) this.sessionLocks.delete(id)
        }
    }

    private require(id: string) {
        const session = this.sessions.get(id)
        if (!session) throw new SessionNotFoundError(id)
        return session
    }

    private async cleanup() {
        const cutoff = Date.now() - this.config.sessionTtlMs
        for (const [id, session] of this.sessions) {
            if (session.updatedAt > cutoff) continue
            await this.withSessionLock(id, async () => {
                if (this.sessions.get(id) !== session || session.updatedAt > cutoff) return
                if (!isTerminal(session.state)) session.setState('failed', 'Session expired after exceeding its lifetime')
                try { await session.dispose() } catch (error) {
                    console.error(JSON.stringify({ level: 'error', event: 'session_cleanup_failed', sessionId: id, message: errorMessage(error) }))
                } finally {
                    if (this.sessions.delete(id)) {
                        this.notifyLifecycle({
                            type: 'session_closed',
                            sessionId: session.id,
                            ownerKeyId: session.ownerKeyId,
                            agentId: session.agentId
                        })
                    }
                }
            })
        }
    }

    private restartCleanup() {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
        this.cleanupTimer = setInterval(
            () => void this.cleanup().catch((error) => {
                console.error(JSON.stringify({ level: 'error', event: 'session_cleanup_failed', message: errorMessage(error) }))
            }),
            this.config.cleanupIntervalMs || 60_000
        )
        this.cleanupTimer.unref?.()
    }

    private defaultWorkspace(agentId: string) {
        const config = this.config.agents[agentId]
        if (config?.protocol === 'a2a') return ''
        return config?.workspace || this.config.workspaceRoots[0] || ''
    }

    private notifyLifecycle(event: SessionLifecycleEvent) {
        for (const listener of this.lifecycleListeners) {
            try {
                listener(structuredClone(event))
            } catch (error) {
                console.error(
                    JSON.stringify({
                        level: 'error',
                        event: 'session_lifecycle_listener_failed',
                        type: event.type,
                        message: errorMessage(error)
                    })
                )
            }
        }
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

function publishFailure(error: ContainedReadError) {
    switch (error.failure) {
        case 'swapped':
            return new SessionRequestError(
                409,
                'Published file changed while it was being opened'
            )
        case 'not-a-file':
            return new SessionRequestError(400, 'Only regular files can be published')
        case 'too-large':
            return new SessionRequestError(
                413,
                `Published file exceeds the ${MAX_PUBLISHED_FILE_BYTES} byte limit`
            )
        case 'outside':
            return new SessionRequestError(
                403,
                'Published files must stay inside the session workspace'
            )
    }
}

function mediaTypeForPath(path: string) {
    switch (extname(path).toLowerCase()) {
        case '.txt':
        case '.log':
        case '.md':
            return 'text/plain'
        case '.json':
            return 'application/json'
        case '.pdf':
            return 'application/pdf'
        case '.png':
            return 'image/png'
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg'
        case '.gif':
            return 'image/gif'
        case '.webp':
            return 'image/webp'
        case '.svg':
            return 'image/svg+xml'
        case '.csv':
            return 'text/csv'
        case '.zip':
            return 'application/zip'
        default:
            return 'application/octet-stream'
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

function isTerminal(state: AgentdSessionState) {
    return state === 'completed' || state === 'failed' || state === 'canceled'
}

function isActive(state: AgentdSessionState) {
    return state === 'running' || state === 'input_required' || state === 'permission_required'
}

function isInteractive(state: AgentdSessionState) {
    return state === 'input_required' || state === 'permission_required'
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
