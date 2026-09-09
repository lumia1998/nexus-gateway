import type { AgentdAgentConfig, AgentdSessionView } from '../types.js'

type SessionCreator = {
    create(
        agentId: string,
        workspace: string | undefined,
        ownerKeyId: string
    ): Promise<AgentdSessionView>
    close(id: string): Promise<AgentdSessionView>
}

export interface DiagnosticStage {
    name: 'validate' | 'handshake' | 'close'
    status: 'passed' | 'failed' | 'skipped'
    durationMs: number
    message?: string
}

export interface DiagnosticResult {
    ok: boolean
    status: 'passed' | 'failed' | 'busy'
    durationMs: number
    stages: DiagnosticStage[]
    message?: string
}

export class DiagnosticConcurrencyError extends Error {
    readonly status = 429
    readonly retryAfterMs = 1_000

    constructor() {
        super('ACP diagnostic capacity has been reached')
        this.name = 'DiagnosticConcurrencyError'
    }
}

/**
 * Run the real SessionManager startup path as a diagnostic.  SessionManager's
 * `create` performs ACP initialize + session/new (or A2A card/transport
 * setup), and `close` releases the process and the session slot.  No prompt
 * is sent here by design.
 */
export class DiagnosticRunner {
    private active = 0

    constructor(private readonly maxConcurrent = 2) {}

    async run(
        sessions: SessionCreator,
        agentId: string,
        workspace: string | undefined,
        agentConfig?: AgentdAgentConfig
    ): Promise<DiagnosticResult> {
        if (this.active >= this.maxConcurrent) throw new DiagnosticConcurrencyError()
        this.active++
        const startedAt = Date.now()
        const stages: DiagnosticStage[] = []
        let session: AgentdSessionView | undefined
        try {
            const validationStartedAt = Date.now()
            if (!agentConfig) {
                stages.push({
                    name: 'validate',
                    status: 'failed',
                    durationMs: elapsed(validationStartedAt),
                    message: 'Configured agent not found'
                })
                return this.result('failed', startedAt, stages, 'Configured agent not found')
            }
            if (agentConfig.enabled === false) {
                stages.push({
                    name: 'validate',
                    status: 'failed',
                    durationMs: elapsed(validationStartedAt),
                    message: 'Agent is disabled'
                })
                return this.result('failed', startedAt, stages, 'Agent is disabled')
            }
            stages.push({
                name: 'validate',
                status: 'passed',
                durationMs: elapsed(validationStartedAt),
                message: 'Agent configuration accepted'
            })

            const startupStartedAt = Date.now()
            try {
                session = await sessions.create(agentId, workspace, 'console:diagnostic')
                stages.push({
                    name: 'handshake',
                    status: 'passed',
                    durationMs: elapsed(startupStartedAt),
                    message: agentConfig.protocol === 'a2a'
                        ? 'A2A transport and session creation completed'
                        : 'Process startup, ACP initialize and session/new completed'
                })
            } catch (error) {
                stages.push({
                    name: 'handshake',
                    status: 'failed',
                    durationMs: elapsed(startupStartedAt),
                    message: safeDiagnosticMessage(error)
                })
                return this.result('failed', startedAt, stages, safeDiagnosticMessage(error))
            }

            const closeStartedAt = Date.now()
            try {
                await sessions.close(session.id)
                stages.push({
                    name: 'close',
                    status: 'passed',
                    durationMs: elapsed(closeStartedAt),
                    message: 'Diagnostic session closed'
                })
                return this.result('passed', startedAt, stages, 'Agent connection diagnostic completed')
            } catch (error) {
                stages.push({
                    name: 'close',
                    status: 'failed',
                    durationMs: elapsed(closeStartedAt),
                    message: safeDiagnosticMessage(error)
                })
                return this.result('failed', startedAt, stages, safeDiagnosticMessage(error))
            }
        } finally {
            // If close itself failed, the SessionManager still owns the
            // session. Do not issue a second unbounded close here; its normal
            // shutdown/cleanup path remains authoritative.
            this.active = Math.max(0, this.active - 1)
        }
    }

    count() {
        return this.active
    }

    private result(
        status: DiagnosticResult['status'],
        startedAt: number,
        stages: DiagnosticStage[],
        message?: string
    ): DiagnosticResult {
        return {
            ok: status === 'passed',
            status,
            durationMs: elapsed(startedAt),
            stages,
            ...(message ? { message } : {})
        }
    }
}

function elapsed(startedAt: number) {
    return Math.max(0, Date.now() - startedAt)
}

/** Keep command lines, absolute paths and credential-shaped values out of UI. */
export function safeDiagnosticMessage(error: unknown) {
    let value = error instanceof Error ? error.message : String(error)
    value = value
        .replace(/Bearer\s+[^\s]+/gi, 'Bearer [redacted]')
        .replace(/(token|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`]+/g, '[path]')
        .replace(/(^|[\s(])\/(?!\/)[^\s"'`]+/g, '$1[path]')
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
    return value.length > 500 ? `${value.slice(0, 500)}…` : value
}
