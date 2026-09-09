import type {
    AgentdAgentConfig,
    AgentdRunControls,
    AgentdPendingRequest,
    AgentdPendingResponse,
    AgentdRunDetail,
    AgentdSessionState,
    AgentdSessionView
} from '../types.js'

export type { AgentdRunControls }
export type AdminRunControls = AgentdRunControls

export interface AdminRunOperationResult {
    run: AgentdRunDetail
    controls: AdminRunControls
    state: AgentdSessionState
    runId: string
    sessionId: string
    retryOfRunId?: string
}

/**
 * Quota state reserved for a retry that is about to create a new session.
 * The reservation is bound as soon as the new session exists so lifecycle
 * events can release each resource independently.
 */
export interface AdminRetryReservation {
    bind(sessionId: string): void
    release(): void
}

export type AdminRetryReservationFactory = (
    ownerKeyId: string
) => AdminRetryReservation

export interface AdminRunSession {
    readonly id: string
    readonly state: AgentdSessionState
    readonly ownerKeyId: string
    snapshot(): AgentdSessionView
    runtimeAvailable(): boolean
    cancel(): Promise<void>
    resolvePending(
        response: AgentdPendingResponse,
        attachmentIds?: string[]
    ): Promise<void>
}

export interface AdminRunOptions {
    getRun(runId: string): AgentdRunDetail
    getSession(sessionId: string): AdminRunSession | undefined
    getAgent(agentId: string): AgentdAgentConfig | undefined
    getOwnerKeyId(runId: string): string | undefined
    withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
    startRetry(
        run: AgentdRunDetail,
        ownerKeyId: string,
        reservation?: AdminRetryReservation
    ): Promise<{ runId: string; sessionId: string }>
    markRetryOf?(newRunId: string, oldRunId: string): unknown
    requestError(status: number, message: string): Error
    /** Optional bounds/clock overrides for embedding and deterministic tests. */
    maxRetryRecords?: number
    retryRecordTtlMs?: number
    now?: () => number
}

interface RetryRecord {
    readonly retryOfRunId: string
    readonly status: 'pending' | 'succeeded'
    readonly newRunId?: string
    readonly sessionId?: string
    readonly createdAt: number
    readonly updatedAt: number
}

const DEFAULT_MAX_RETRY_RECORDS = 512
const DEFAULT_RETRY_RECORD_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Administrator operations are keyed by persisted run IDs rather than API
 * keys.  The session identity check is repeated inside the per-session lock
 * immediately before every action; an old run can therefore never cancel or
 * answer a newer turn on the same session.
 */
export class AdminRunManager {
    private retryRecords = new Map<string, RetryRecord>()
    private retryRelations = new Map<string, string>()
    private readonly maxRetryRecords: number
    private readonly retryRecordTtlMs: number
    private readonly now: () => number

    constructor(private readonly options: AdminRunOptions) {
        this.maxRetryRecords = positiveInteger(
            options.maxRetryRecords,
            DEFAULT_MAX_RETRY_RECORDS
        )
        this.retryRecordTtlMs = positiveInteger(
            options.retryRecordTtlMs,
            DEFAULT_RETRY_RECORD_TTL_MS
        )
        this.now = options.now || Date.now
    }

    getRunControls(runId: string): AdminRunControls {
        this.pruneRetryState()
        const run = this.options.getRun(runId)
        const session = this.options.getSession(run.sessionId)
        const snapshot = session?.snapshot()
        const current = Boolean(snapshot && snapshot.runId === run.id)
        const effectiveState = current ? snapshot!.state : run.state
        const active = isActive(effectiveState)
        const pendingRequest =
            current && snapshot?.pendingRequest
                ? structuredClone(snapshot.pendingRequest)
                : undefined

        let unavailableReason: string | undefined
        // A terminal historical run does not need its in-memory session in
        // order to be retried. Session availability only explains why the
        // current active turn cannot be controlled. A session may already be
        // processing a newer turn while an older terminal run is retried in
        // its own session.
        if (isActive(run.state)) {
            if (!session) {
                unavailableReason = 'The run session is no longer available'
            } else if (!current) {
                unavailableReason = 'The run is no longer the current session turn'
            } else if (!session.runtimeAvailable()) {
                unavailableReason = 'Agent runtime is unavailable'
            }
        }

        let canRetry = isTerminal(run.state)
        if (canRetry && run.taskTruncated) {
            canRetry = false
            unavailableReason =
                'This run cannot be retried because its task record was truncated'
        } else if (canRetry && (run.inputAttachmentCount || 0) > 0) {
            canRetry = false
            unavailableReason =
                'This run cannot be retried because it used input attachments'
        } else if (canRetry) {
            const agent = this.options.getAgent(run.agentId)
            if (!agent || agent.enabled === false) {
                canRetry = false
                unavailableReason = 'The configured agent is unavailable'
            }
        }

        const retryRecord = this.currentRetryRecord(run.id)
        if (canRetry && retryRecord?.status === 'pending') {
            canRetry = false
            unavailableReason = 'Retry is already in progress for this run'
        }

        return {
            canCancel: current && active && Boolean(session?.runtimeAvailable()),
            canRetry,
            ...(pendingRequest ? { pendingRequest } : {}),
            ...(unavailableReason ? { unavailableReason } : {})
        }
    }

    async cancelRun(runId: string): Promise<AdminRunOperationResult> {
        const run = this.options.getRun(runId)
        return this.options.withSessionLock(run.sessionId, async () => {
            const current = this.assertCurrent(runId)
            if (!isActive(current.state)) {
                throw this.options.requestError(409, 'The run is no longer active')
            }
            if (!current.runtimeAvailable()) {
                throw this.options.requestError(409, 'Agent runtime is unavailable')
            }
            await current.cancel()
            return this.resultFor(runId)
        })
    }

    async respondRun(
        runId: string,
        response: AgentdPendingResponse,
        attachmentIds: string[] = []
    ): Promise<AdminRunOperationResult> {
        const run = this.options.getRun(runId)
        return this.options.withSessionLock(run.sessionId, async () => {
            const current = this.assertCurrent(runId)
            if (!current.runtimeAvailable()) {
                throw this.options.requestError(409, 'Agent runtime is unavailable')
            }
            if (!current.snapshot().pendingRequest) {
                throw this.options.requestError(
                    409,
                    'Pending request is no longer available'
                )
            }
            await current.resolvePending(response, attachmentIds)
            return this.resultFor(runId)
        })
    }

    async retryRun(
        runId: string,
        reserveRetry?: AdminRetryReservationFactory
    ): Promise<AdminRunOperationResult> {
        this.pruneRetryState()
        const existing = this.currentRetryRecord(runId)
        if (existing) {
            if (existing.status === 'pending') {
                throw this.options.requestError(
                    409,
                    'Retry is already in progress for this run'
                )
            }
            return this.resultFor(
                existing.newRunId!,
                existing.retryOfRunId,
                existing.sessionId
            )
        }

        const run = this.options.getRun(runId)
        if (!isTerminal(run.state)) {
            throw this.options.requestError(409, 'Only terminal runs can be retried')
        }
        if (run.taskTruncated) {
            throw this.options.requestError(
                409,
                'This run cannot be retried because its task record was truncated'
            )
        }
        if ((run.inputAttachmentCount || 0) > 0) {
            throw this.options.requestError(
                409,
                'This run cannot be retried because it used input attachments'
            )
        }

        // Set this synchronously before the first await.  A second request in
        // the same event-loop turn therefore receives 409 instead of creating
        // another session.
        const timestamp = this.now()
        this.retryRecords.set(runId, {
            retryOfRunId: runId,
            status: 'pending',
            createdAt: timestamp,
            updatedAt: timestamp
        })
        let started: { runId: string; sessionId: string } | undefined
        let reservation: AdminRetryReservation | undefined
        try {
            const ownerKeyId = this.options.getOwnerKeyId(runId)
            if (!ownerKeyId) {
                throw this.options.requestError(
                    409,
                    'The original run owner is unavailable'
                )
            }
            // The record above is the synchronous deduplication gate.  Only
            // after it succeeds may the caller reserve resources for a new
            // retry; a completed duplicate therefore never consumes quota.
            reservation = reserveRetry?.(ownerKeyId)
            started = await this.options.startRetry(run, ownerKeyId, reservation)
            reservation?.bind(started.sessionId)
            this.retryRelations.set(started.runId, runId)
            try {
                void Promise.resolve(
                    this.options.markRetryOf?.(started.runId, runId)
                ).catch(() => undefined)
            } catch {
                // The in-memory relation still makes this attempt dedupable.
                // Persistence failures must not turn a successfully started
                // task into an apparent retry failure.
            }
            this.retryRecords.set(runId, {
                retryOfRunId: runId,
                status: 'succeeded',
                newRunId: started.runId,
                sessionId: started.sessionId,
                createdAt: timestamp,
                updatedAt: this.now()
            })
            this.pruneRetryState()
            return this.resultFor(started.runId, runId, started.sessionId)
        } catch (error) {
            reservation?.release()
            this.dropRetryRecord(runId)
            if (started) this.dropRetryRelation(started.runId, runId)
            throw error
        }
    }

    retryOfRunId(runId: string) {
        this.pruneRetryState()
        const sourceRunId = this.retryRelations.get(runId)
        if (!sourceRunId) return undefined
        try {
            this.options.getRun(runId)
            return sourceRunId
        } catch (error) {
            if (!isMissingRunError(error)) throw error
            const record = this.retryRecords.get(sourceRunId)
            if (record?.newRunId === runId) {
                this.dropRetryRecord(sourceRunId, record)
            } else {
                this.dropRetryRelation(runId, sourceRunId)
            }
            return undefined
        }
    }

    private currentRetryRecord(runId: string) {
        const record = this.retryRecords.get(runId)
        if (!record || record.status === 'pending') return record
        if (!record.newRunId) {
            this.dropRetryRecord(runId, record)
            return undefined
        }
        try {
            this.options.getRun(record.newRunId)
            return record
        } catch (error) {
            if (!isMissingRunError(error)) throw error
            this.dropRetryRecord(runId, record)
            return undefined
        }
    }

    private pruneRetryState() {
        const now = this.now()
        for (const [runId, record] of this.retryRecords) {
            if (
                record.status === 'succeeded' &&
                now - record.updatedAt >= this.retryRecordTtlMs
            ) {
                this.dropRetryRecord(runId, record)
            }
        }

        if (this.retryRecords.size <= this.maxRetryRecords) return
        const succeeded = Array.from(this.retryRecords.entries())
            .filter(([, record]) => record.status === 'succeeded')
            .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        for (const [runId, record] of succeeded) {
            if (this.retryRecords.size <= this.maxRetryRecords) break
            this.dropRetryRecord(runId, record)
        }
    }

    private dropRetryRecord(runId: string, record?: RetryRecord) {
        const current = this.retryRecords.get(runId)
        if (!current || (record && current !== record)) return
        this.retryRecords.delete(runId)
        if (current.newRunId) {
            this.dropRetryRelation(current.newRunId, runId)
        }
    }

    private dropRetryRelation(newRunId: string, sourceRunId: string) {
        if (this.retryRelations.get(newRunId) === sourceRunId) {
            this.retryRelations.delete(newRunId)
        }
    }

    private assertCurrent(runId: string) {
        const run = this.options.getRun(runId)
        const session = this.options.getSession(run.sessionId)
        if (!session) {
            throw this.options.requestError(
                409,
                'The run session is no longer available'
            )
        }
        const snapshot = session.snapshot()
        if (snapshot.runId !== runId) {
            throw this.options.requestError(
                409,
                'The run is no longer the current session turn'
            )
        }
        return session
    }

    private resultFor(
        runId: string,
        retryOfRunId?: string,
        sessionId?: string
    ): AdminRunOperationResult {
        const run = this.options.getRun(runId)
        const controls = this.getRunControls(runId)
        return {
            run: structuredClone(run),
            controls,
            state: run.state,
            runId: run.id,
            sessionId: sessionId || run.sessionId,
            ...(retryOfRunId ? { retryOfRunId } : {})
        }
    }
}

function positiveInteger(value: number | undefined, fallback: number) {
    return Number.isFinite(value) && Number(value) > 0
        ? Math.floor(Number(value))
        : fallback
}

function isMissingRunError(error: unknown) {
    if (isRecord(error) && error.status === 404) return true
    return error instanceof Error && /run not found/i.test(error.message)
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isActive(state: AgentdSessionState) {
    return (
        state === 'running' ||
        state === 'input_required' ||
        state === 'permission_required'
    )
}

function isTerminal(state: AgentdSessionState) {
    return state === 'completed' || state === 'failed' || state === 'canceled'
}
