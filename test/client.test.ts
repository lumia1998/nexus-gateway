import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createGatewayClient } from '../examples/client.mjs'

test('example client recovers snapshots, deduplicates reconnects and stops on revoked credentials', async () => {
    let streams = 0
    const operations: Array<{ path: string, body: unknown }> = []
    const server = http.createServer(async (req, res) => {
        assert.equal(req.headers.authorization, 'Bearer example-client-key')
        if (req.url?.endsWith('/events')) {
            streams++
            if (streams === 3) { res.writeHead(401).end(); return }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' })
            if (streams === 1) {
                res.end('id: 9\nevent: reset\ndata: {"reason":"expired","snapshotUrl":"https://untrusted.example"}\n\n')
            } else {
                assert.equal(req.headers['last-event-id'], '10')
                res.write('id: 10\nevent: assistant_chunk\ndata: {"id":"10","type":"assistant_chunk"}\n\n')
                res.end('id: 11\nevent: assistant_chunk\ndata: {"id":"11","type":"assistant_chunk","data":{"text":"新内容"}}\n\n')
            }
            return
        }
        if (req.method === 'GET') {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ id: 'session', state: 'input_required', output: 'snapshot output', lastEventId: '10' }))
            return
        }
        let body = ''
        for await (const chunk of req) body += chunk
        operations.push({ path: req.url!, body: body ? JSON.parse(body) : undefined })
        res.setHeader('Content-Type', 'application/json')
        res.end('{}')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const client = createGatewayClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'example-client-key')
    const events = client.events('session', { after: '0' })
    try {
        const reset = await events.next()
        assert.equal(reset.value?.type, 'reset')
        assert.equal(reset.value?.data.output, 'snapshot output')
        const event = await events.next()
        assert.equal(event.value?.id, '11')
        assert.equal(event.value?.data.text, '新内容')
        await assert.rejects(events.next(), /401/)
        await client.resolve('session', 'permission-request', { optionId: 'allow-once' })
        await client.resolve('session', 'input-request', { message: 'user answer' })
        await client.cancel('session')
        assert.deepEqual(operations, [
            { path: '/v1/sessions/session/requests/permission-request/resolve', body: { optionId: 'allow-once' } },
            { path: '/v1/sessions/session/requests/input-request/resolve', body: { message: 'user answer' } },
            { path: '/v1/sessions/session/cancel', body: {} }
        ])
    } finally {
        await events.return(undefined)
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})
