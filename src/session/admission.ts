import type { AgentdSessionState } from '../types.js'

export interface AdmissionSession {
    readonly id: string
    readonly state: AgentdSessionState
    readonly updatedAt: number
    dispose(): Promise<void>
}

export interface SessionAdmissionOptions {
    maxSessions(): number
    sessionCount(): number
    sessions(): Iterable<AdmissionSession>
    isCurrent(session: AdmissionSession): boolean
    withSessionLock<T>(id: string, operation: () => Promise<T>): Promise<T>
    removeSession(id: string): void
    requestError(status: number, message: string): Error
}

/**
 * Serialises admission decisions and owns the pending-create reservation.
 * A reservation is held until the session has been inserted, so concurrent
 * creates cannot temporarily exceed maxSessions while an ACP process starts.
 */
export class SessionAdmission {
    private pendingCreates = 0
    private closing = false

    constructor(private readonly options: SessionAdmissionOptions) {}

    markClosing() {
        this.closing = true
    }

    isClosing() {
        return this.closing
    }

    pendingCount() {
        return this.pendingCreates
    }

    async reserve() {
        if (this.closing) {
            throw this.options.requestError(503, 'Gateway is shutting down')
        }
        await this.ensureCapacity()
        this.pendingCreates++
        let reserved = true
        return () => {
            if (!reserved) return
            reserved = false
            this.pendingCreates--
        }
    }

    async ensureCapacity() {
        const limit = this.options.maxSessions()
        if (this.options.sessionCount() + this.pendingCreates < limit) return
        const terminal = Array.from(this.options.sessions())
            .filter((session) => isTerminal(session.state))
            .sort((left, right) => left.updatedAt - right.updatedAt)

        while (
            this.options.sessionCount() + this.pendingCreates >= limit &&
            terminal.length
        ) {
            const session = terminal.shift()!
            await this.options.withSessionLock(session.id, async () => {
                if (
                    !this.options.isCurrent(session) ||
                    !isTerminal(session.state)
                ) {
                    return
                }
                await session.dispose()
                this.options.removeSession(session.id)
            })
        }
        if (this.options.sessionCount() + this.pendingCreates >= limit) {
            throw this.options.requestError(
                429,
                'Session capacity has been reached'
            )
        }
    }
}

function isTerminal(state: AgentdSessionState) {
    return state === 'completed' || state === 'failed' || state === 'canceled'
}
