import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { A2AClientRuntime, probeA2AAgent } from '../src/a2a/runtime.js'

test('A2A readiness discovers a v1 Agent Card through authenticated fetch', async () => {
    let base = ''
    let authorization = ''
    let requestedPath = ''
    const server = http.createServer((request, response) => {
        authorization = String(request.headers.authorization || '')
        requestedPath = request.url || ''
        if (authorization !== 'Bearer remote-secret') {
            response.writeHead(401).end('unauthorized')
            return
        }
        response.setHeader('Content-Type', 'application/json')
        response.end(
            JSON.stringify({
                name: 'Remote Research',
                description: 'A real A2A test agent',
                supportedInterfaces: [
                    {
                        url: base,
                        protocolBinding: 'JSONRPC',
                        tenant: '',
                        protocolVersion: '1.0'
                    }
                ],
                provider: { organization: 'Test', url: base },
                version: '1.2.3',
                capabilities: {
                    streaming: false,
                    pushNotifications: false,
                    extensions: []
                },
                securitySchemes: {},
                securityRequirements: [],
                defaultInputModes: ['text/plain'],
                defaultOutputModes: ['text/plain'],
                skills: [],
                signatures: []
            })
        )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
        const result = await probeA2AAgent('research', {
            protocol: 'a2a',
            agentUrl: base,
            auth: { type: 'bearer', value: 'remote-secret' },
            timeoutMs: 5_000
        })
        assert.equal(authorization, 'Bearer remote-secret')
        assert.equal(result.ready, true)
        assert.equal(result.name, 'Remote Research')
        assert.equal(result.version, '1.2.3')
        assert.equal(result.protocol, 'a2a')
        assert.equal(requestedPath, '/.well-known/agent-card.json')

        const directCard = await probeA2AAgent('research', {
            protocol: 'a2a',
            agentCardUrl: `${base}/custom/cards/research.json`,
            preferredTransport: 'jsonrpc',
            auth: { type: 'bearer', value: 'remote-secret' },
            timeoutMs: 5_000
        })
        assert.equal(directCard.ready, true)
        assert.equal(requestedPath, '/custom/cards/research.json')

        const rejected = await probeA2AAgent('research', {
            protocol: 'a2a',
            agentUrl: base,
            auth: { type: 'bearer', value: 'wrong-secret' },
            timeoutMs: 5_000
        })
        assert.equal(rejected.ready, false)
        assert.match(rejected.error || '', /401|fetch agent card/i)
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

test('A2A requests carry input files as raw Parts with filename and media type', () => {
    const runtime = new A2AClientRuntime(
        {
            protocol: 'a2a',
            agentCardUrl: 'http://127.0.0.1:8787/.well-known/agent-card.json',
            timeoutMs: 60_000
        },
        { id: 'session-1' } as any,
        30 * 60 * 1000
    )
    const request = (runtime as any).messageRequest('请分析附件', [
        {
            id: 'input-1',
            name: '需求.pdf',
            mediaType: 'application/pdf',
            bytes: Buffer.from([0, 255, 1])
        }
    ])
    assert.equal(request.message.parts[0].content.$case, 'text')
    assert.equal(request.message.parts[1].content.$case, 'raw')
    assert.deepEqual(
        [...request.message.parts[1].content.value],
        [0, 255, 1]
    )
    assert.equal(request.message.parts[1].filename, '需求.pdf')
    assert.equal(request.message.parts[1].mediaType, 'application/pdf')
})
