import { setTimeout as delay } from 'node:timers/promises'

/** Minimal Node 20+ client. Keep API Keys out of URLs and browser storage. */
export function createGatewayClient(baseUrl, apiKey) {
    const base = new URL(baseUrl)
    const headers = { Authorization: `Bearer ${apiKey}` }
    const route = (sessionId) => `/v1/sessions/${encodeURIComponent(sessionId)}`
    async function request(path, method = 'GET', body, signal) {
        const response = await fetch(new URL(path, base), {
            method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
            redirect: 'error'
        })
        if (!response.ok) {
            const error = new Error(`Gateway request failed (${response.status})`)
            error.status = response.status
            await response.body?.cancel()
            throw error
        }
        return response.json()
    }
    return {
        createSession: (agentId, workspace) => request('/v1/sessions', 'POST', { agentId, workspace }),
        snapshot: (id) => request(route(id)),
        message: (id, message) => request(`${route(id)}/message`, 'POST', { message }),
        resolve: (id, requestId, answer) => request(`${route(id)}/requests/${encodeURIComponent(requestId)}/resolve`, 'POST', answer),
        cancel: (id) => request(`${route(id)}/cancel`, 'POST', {}),
        close: (id) => request(route(id), 'DELETE'),
        /** A reset yields a replacement snapshot; old discarded events are not replayed. */
        async *events(id, { after, signal = new AbortController().signal } = {}) {
            let cursor = after
            let retries = 0
            while (!signal.aborted) {
                const connection = new AbortController()
                const combined = AbortSignal.any([signal, connection.signal])
                let timer = setTimeout(() => connection.abort(new Error('SSE connection timeout')), 15_000)
                let reader
                let reset = false
                try {
                    const response = await fetch(new URL(`${route(id)}/events`, base), {
                        headers: { ...headers, ...(cursor === undefined ? {} : { 'Last-Event-ID': cursor }) },
                        signal: combined, redirect: 'error'
                    })
                    clearTimeout(timer)
                    if (!response.ok) {
                        const error = new Error(`SSE request failed (${response.status})`)
                        error.status = response.status
                        await response.body?.cancel()
                        throw error
                    }
                    reader = response.body.getReader()
                    const decoder = new TextDecoder()
                    let buffer = ''
                    while (!signal.aborted && !reset) {
                        timer = setTimeout(() => connection.abort(new Error('SSE heartbeat timeout')), 45_000)
                        const { value, done } = await reader.read()
                        clearTimeout(timer)
                        if (done) break
                        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
                        if (buffer.length > 2 * 1024 * 1024) throw new Error('SSE frame limit exceeded')
                        let end
                        while ((end = buffer.indexOf('\n\n')) >= 0) {
                            const frame = buffer.slice(0, end)
                            buffer = buffer.slice(end + 2)
                            const lines = frame.split('\n')
                            const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
                            if (!data) continue // Heartbeat comments carry no event.
                            const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim()
                            const eventId = lines.find((line) => line.startsWith('id:'))?.slice(3).trim()
                            if (type === 'reset') {
                                // Use our fixed same-origin Session route, never a remote recovery URL.
                                const snapshot = await request(route(id), 'GET', undefined, signal)
                                cursor = snapshot.lastEventId || '0'
                                yield { type: 'reset', data: snapshot, recovery: JSON.parse(data) }
                                reset = true
                                break
                            }
                            if (!eventId || !/^\d+$/.test(eventId)) continue
                            if (cursor !== undefined && BigInt(eventId) <= BigInt(cursor)) continue
                            cursor = eventId
                            retries = 0
                            yield JSON.parse(data)
                        }
                    }
                } catch (error) {
                    if (signal.aborted) return
                    // A revoked Key, narrowed scope or deleted/restarted Session needs user action.
                    if ([401, 403, 404].includes(error.status)) throw error
                } finally {
                    clearTimeout(timer)
                    connection.abort()
                    await reader?.cancel().catch(() => {})
                }
                if (!reset && !signal.aborted) {
                    await delay(Math.min(30_000, 500 * 2 ** Math.min(retries++, 6)) + Math.random() * 250,
                        undefined, { signal }).catch((error) => { if (!signal.aborted) throw error })
                }
            }
        }
    }
}
