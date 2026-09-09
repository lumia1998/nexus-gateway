import type { AgentdEvent, AgentdEventType } from './types.js'

export class SessionEventLog {
    private sequence = 0
    private events: AgentdEvent[] = []
    private listeners = new Set<(event: AgentdEvent) => void>()

    constructor(
        private readonly sessionId: string,
        private readonly maxEvents: number
    ) {}

    append(type: AgentdEventType, data?: unknown) {
        const event: AgentdEvent = {
            id: String(++this.sequence),
            sessionId: this.sessionId,
            type,
            timestamp: Date.now(),
            data
        }
        this.events.push(event)
        if (this.events.length > this.maxEvents) {
            this.events.splice(0, this.events.length - this.maxEvents)
        }
        for (const listener of this.listeners) {
            try {
                listener(structuredClone(event))
            } catch (error) {
                console.error(
                    JSON.stringify({
                        level: 'error',
                        event: 'session_event_listener_failed',
                        sessionId: this.sessionId,
                        message: error instanceof Error ? error.message : String(error)
                    })
                )
            }
        }
        return event
    }

    after(id?: string) {
        return this.replay(id).events
    }

    replay(id?: string) {
        const sequence = id === undefined ? 0 : Number(id)
        const earliest = Number(this.events[0]?.id || this.sequence + 1)
        const reason = id !== undefined && (!/^\d+$/.test(id) || !Number.isSafeInteger(sequence))
            ? 'invalid'
            : sequence > this.sequence ? 'ahead'
            : sequence < earliest - 1 ? 'expired' : undefined
        return {
            earliestId: this.events[0]?.id ?? null,
            latestId: String(this.sequence),
            reset: reason ? { reason, requestedAfter: id ?? null } : undefined,
            events: reason ? [] : this.events
                .filter((event) => Number(event.id) > sequence)
                .map((event) => structuredClone(event))
        }
    }

    subscribe(listener: (event: AgentdEvent) => void) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    get lastId() {
        return this.events.at(-1)?.id
    }
}
