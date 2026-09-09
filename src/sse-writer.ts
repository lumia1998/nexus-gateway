import type { ServerResponse } from 'node:http'

/** A false write already accepted the chunk. Queue later chunks until drain,
 * with both a byte ceiling and a deadline independent of socket activity. */
export function createSseWriter(response: ServerResponse, close: () => void, maxBytes = 512 * 1024, drainMs = 5_000) {
    let stopped = false
    let blocked = false
    let queuedBytes = 0
    const queue: string[] = []
    let deadline: NodeJS.Timeout | undefined
    const stop = () => {
        if (stopped) return
        stopped = true
        clearTimeout(deadline)
        response.off('drain', drain)
        queue.length = 0
        queuedBytes = 0
    }
    const fail = () => { stop(); close() }
    const send = (chunk: string) => {
        try {
            if (!response.write(chunk)) {
                blocked = true
                deadline = setTimeout(fail, drainMs)
                deadline.unref?.()
            }
        } catch { fail() }
    }
    const drain = () => {
        clearTimeout(deadline)
        blocked = false
        while (!stopped && !blocked && queue.length) {
            const chunk = queue.shift()!
            queuedBytes -= Buffer.byteLength(chunk)
            send(chunk)
        }
    }
    response.on('drain', drain)
    return {
        write(chunk: string) {
            if (stopped) return false
            const size = Buffer.byteLength(chunk)
            if (response.destroyed || response.writableEnded || size + queuedBytes + response.writableLength > maxBytes) {
                fail()
                return false
            }
            if (blocked) { queue.push(chunk); queuedBytes += size }
            else send(chunk)
            return !stopped
        },
        stop
    }
}
