import type { IncomingMessage, ServerResponse } from 'node:http'
import { createSseWriter } from '../sse-writer.js'
import type { AgentdEvent } from '../types.js'
import type { SessionManager } from '../session.js'

/**
 * Own the lifecycle of one session event connection. Authentication and quota
 * admission happen in the data route; this module is responsible only for
 * replay, authorization revocation, heartbeats, and releasing the slot.
 */
export function streamSessionEvents(
    request: IncomingMessage,
    response: ServerResponse,
    sessions: SessionManager,
    sessionId: string,
    after: string | undefined,
    release: () => void,
    watchAuthorization: (close: () => void) => (() => void)
) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    response.flushHeaders?.()
    let unsubscribe = () => {}
    let unwatch = () => {}
    let heartbeat: NodeJS.Timeout | undefined
    let closed = false
    const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
        unwatch()
        writer.stop()
        request.off('close', close)
        response.off('close', close)
        request.socket.off('error', close)
        response.destroy()
        release()
    }
    const writer = createSseWriter(response, close)
    const writeEvent = (event: AgentdEvent) => writer.write(
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )
    request.once('close', close)
    response.once('close', close)
    request.socket.once('error', close)
    try {
        unwatch = watchAuthorization(close)
        if (closed) return
        const replay = sessions.eventReplay(sessionId, after)
        if (replay.reset) {
            // Keep this control frame bounded even when a snapshot has large
            // output. Reconnect with the advertised cursor and snapshot URL.
            writer.write(
                `id: ${replay.latestId}\nevent: reset\ndata: ${JSON.stringify({
                    ...replay.reset,
                    earliestId: replay.earliestId,
                    latestId: replay.latestId,
                    snapshotUrl: `/v1/sessions/${encodeURIComponent(sessionId)}`
                })}\n\n`
            )
        } else {
            for (const event of replay.events) if (!writeEvent(event)) break
        }
        if (closed) return
        unsubscribe = sessions.subscribe(sessionId, writeEvent)
        heartbeat = setInterval(() => writer.write(': heartbeat\n\n'), 15_000)
        heartbeat.unref?.()
    } catch {
        close()
    }
}
