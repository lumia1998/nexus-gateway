import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { type TestContext } from 'node:test'
import { A2AClientRuntime, probeA2AAgent } from '../src/a2a/runtime.js'
import type { AgentdA2AConfig } from '../src/types.js'

async function serve(t: TestContext, handler: http.RequestListener) {
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function card(url: string, binding = 'JSONRPC', legacy = false) {
    return {
        name: 'Remote', description: 'Test agent', version: '1',
        capabilities: { streaming: false }, defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'], skills: [],
        ...(legacy ? { url, preferredTransport: binding, protocolVersion: '0.3.0' }
            : { supportedInterfaces: [{ url, protocolBinding: binding, protocolVersion: '1.0', tenant: '' }] })
    }
}

function sink() {
    return {
        state: 'created', output: '', error: '',
        setState(state: string, error = '') { this.state = state; this.error = error },
        clearPending() {}, emit() {}, setProtocolSessionId() {}, addArtifact() {},
        appendOutput(text: string) { this.output += text },
        completeTurn() { this.state = 'completed'; return true }
    }
}

test('A2A card redirects cannot forward a custom authentication header', async (t) => {
    let foreignRequests = 0
    const foreign = await serve(t, (_request, response) => {
        foreignRequests++
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(card(foreign)))
    })
    const source = await serve(t, (_request, response) => response.writeHead(302, { location: foreign }).end())
    const result = await probeA2AAgent('remote', {
        protocol: 'a2a', agentCardUrl: source + '/card', timeoutMs: 1000,
        auth: { type: 'header', headerName: 'X-Api-Key', value: 'test-secret' }
    })
    assert.equal(foreignRequests, 0, 'redirect target must never receive a request')
    assert.equal(result.ready, false)
})

test('A2A JSONRPC and REST transport redirects fail before contacting another origin', async (t) => {
    let foreignRequests = 0
    const foreign = await serve(t, (_request, response) => { foreignRequests++; response.end('{}') })
    for (const binding of ['JSONRPC', 'HTTP+JSON']) {
        const source = await serve(t, (request, response) => {
            if (request.url === '/card') {
                response.setHeader('content-type', 'application/json')
                response.end(JSON.stringify(card(source + '/api', binding)))
            } else response.writeHead(307, { location: foreign }).end()
        })
        const state = sink()
        const runtime = new A2AClientRuntime({ protocol: 'a2a', agentCardUrl: source + '/card', timeoutMs: 1000,
            auth: { type: 'header', headerName: 'X-Api-Key', value: 'test-secret' } }, state as any, 1000)
        await runtime.start()
        await runtime.prompt('Work')
        await runtime.dispose()
        assert.equal(foreignRequests, 0, binding + ' must not follow a redirect')
        assert.equal(state.state, 'failed')
    }
})

test('A2A rejects cross-origin v1, legacy and additional interface URLs at discovery', async (t) => {
    let foreignRequests = 0
    const foreign = await serve(t, (_request, response) => { foreignRequests++; response.end('{}') })
    let value: any
    const source = await serve(t, (_request, response) => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(value))
    })
    const cases = [
        card(foreign),
        card(foreign, 'JSONRPC', true),
        { ...card(source), supportedInterfaces: [
            { url: source, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
            { url: foreign, protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }
        ] },
        { ...card(source, 'JSONRPC', true), additionalInterfaces: [{ url: foreign, transport: 'HTTP+JSON' }] },
        card(source.replace('127.0.0.1', 'localhost')),
        card(source.replace('http:', 'https:')),
        card(source.replace('http://', 'http://user:pass@')),
        card(source + '/api#fragment')
    ]
    for (value of cases) {
        const config: AgentdA2AConfig = { protocol: 'a2a', agentCardUrl: source + '/card', timeoutMs: 1000,
            auth: { type: 'bearer', value: 'test-secret' } }
        const result = await probeA2AAgent('remote', config)
        assert.equal(result.ready, false, JSON.stringify(value))
        const runtime = new A2AClientRuntime(config, sink() as any, 1000)
        await assert.rejects(() => runtime.start(), /A2A.*URL|same origin/i)
        await runtime.dispose()
    }
    assert.equal(foreignRequests, 0)
})

test('same-origin A2A discovery and messaging retain both protocols, auth modes and legacy cards', async (t) => {
    for (const legacy of [false, true]) for (const binding of ['JSONRPC', 'HTTP+JSON']) {
        const received: string[] = []
        const source = await serve(t, async (request, response) => {
            received.push(String(request.headers['x-api-key'] || request.headers.authorization || ''))
            response.setHeader('content-type', 'application/json')
            if (request.method === 'GET') {
                response.end(JSON.stringify(card(source + '/api', binding, legacy)))
                return
            }
            let body = ''
            for await (const chunk of request) body += chunk
            const input = JSON.parse(body)
            const message = legacy
                ? { kind: 'message', messageId: 'reply', role: 'agent', parts: [{ kind: 'text', text: 'Done' }] }
                : { message: { messageId: 'reply', role: 'ROLE_AGENT', parts: [{ text: 'Done' }] } }
            const result = legacy && binding === 'HTTP+JSON'
                ? { msg: { messageId: 'reply', role: 'ROLE_AGENT', content: [{ text: 'Done' }] } } : message
            response.end(JSON.stringify(binding === 'JSONRPC' ? { jsonrpc: '2.0', id: input.id, result } : result))
        })
        const state = sink()
        const auth: AgentdA2AConfig['auth'] = legacy ? { type: 'bearer', value: 'test-secret' }
            : { type: 'header', headerName: 'X-Api-Key', value: 'test-secret' }
        const config: AgentdA2AConfig = { protocol: 'a2a', timeoutMs: 1000, auth,
            ...(legacy ? { agentUrl: source } : { agentCardUrl: source + '/custom/card.json' }),
            preferredTransport: binding === 'JSONRPC' ? 'jsonrpc' : 'http-json' }
        const runtime = new A2AClientRuntime(config, state as any, 1000)
        await runtime.start()
        await runtime.prompt('Work')
        await runtime.dispose()
        assert.equal(state.state, 'completed', `${legacy}/${binding}: ${state.error}`)
        assert.equal(state.output, 'Done')
        assert.equal(received.length, 2)
        assert.ok(received.every((value) => value === (legacy ? 'Bearer test-secret' : 'test-secret')))
    }
})
