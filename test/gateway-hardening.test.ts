import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { AddressInfo } from 'node:net'
import { loadAgentdConfig } from '../src/config.js'
import { AgentdControlPlane } from '../src/control-plane.js'
import { createAgentdServer } from '../src/server.js'
import { closeServer } from '../src/index.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import { SessionManager } from '../src/session.js'
import { WorkspacePolicy } from '../src/workspace.js'
import { AcpProcessRuntime } from '../src/acp/runtime.js'
import { createSseWriter } from '../src/sse-writer.js'

// Node fetch may replace Host. Use the HTTP wire API to test attacker-supplied authorities.
function wire(url: string, body?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number }>((resolve, reject) => {
        const request = http.request(url, { method: body === undefined ? 'GET' : 'POST', headers }, (response) => {
            response.resume()
            response.on('end', () => resolve({ status: response.statusCode! }))
        })
        request.on('error', reject)
        request.end(body === undefined ? undefined : JSON.stringify(body))
    })
}

async function fixture(extra = {}) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-hardening-'))
    const file = path.join(directory, 'config.json')
    await writeFile(file, JSON.stringify({ initialized: false, workspaceRoots: [directory], agents: {}, ...extra }))
    const config = await loadAgentdConfig(file)
    const policy = await WorkspacePolicy.create(config.workspaceRoots)
    const manager = new SessionManager(config, policy, createDriverRegistry(config))
    const control = new AgentdControlPlane(file, config, manager)
    const server = createAgentdServer(config, manager, control)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { directory, file, config, manager, control, base, async close() {
        await closeServer(server); await manager.shutdown(); await rm(directory, { recursive: true, force: true })
    } }
}

test('LAN bootstrap requires process-local proof, validates exact origins, and consumes proof once', async () => {
    const f = await fixture({ publicOrigins: ['https://gateway.example'] })
    const token = f.control.setupToken!
    const initialize = (setupToken?: string, headers = {}) => wire(f.base + '/v1/bootstrap/initialize',
        { setupToken, password: 'a-test-password', confirmPassword: 'a-test-password' },
        { Origin: f.base, 'Content-Type': 'application/json', ...headers })
    try {
        const status = await fetch(f.base + '/v1/bootstrap/status')
        assert.equal((await status.text()).includes(token), false)
        const replacement = new AgentdControlPlane(f.file, f.config, f.manager)
        assert.notEqual(replacement.setupToken, token)
        assert.equal(replacement.verifySetupToken(token), false)
        const lan = Object.values(os.networkInterfaces()).flat().find((item) => item?.family === 'IPv4' && !item.internal)?.address
        if (lan) assert.equal((await wire(f.base.replace('127.0.0.1', lan) + '/ui/')).status, 200)
        assert.equal((await wire(f.base + '/ui/', undefined, { Host: 'evil.example' })).status, 403)
        assert.equal((await wire(f.base + '/ui/', undefined, { Host: 'GATEWAY.EXAMPLE:443' })).status, 200)
        assert.equal((await wire(f.base + '/ui/', undefined, { Host: 'gateway.example:444' })).status, 403)
        assert.equal((await initialize(undefined)).status, 403)
        assert.equal((await initialize('wrong')).status, 403)
        assert.equal((await initialize(token, { Host: 'evil.example', Origin: 'http://evil.example' })).status, 403)
        assert.equal((await initialize(token, { Origin: f.base + '/path' })).status, 403)
        assert.equal((await initialize(token, { Origin: f.base.replace('http:', 'https:') })).status, 403)
        assert.equal((await initialize(token, { Host: 'GATEWAY.EXAMPLE:443', Origin: 'https://gateway.example' })).status, 201)
        assert.equal(f.control.setupToken, undefined)
        assert.equal((await initialize(token)).status, 409)
        const login = await fetch(f.base + '/v1/admin/auth/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-test-password' }) })
        assert.equal(login.status, 200)
    } finally { await f.close() }
})

test('startup credentials cannot fall back after disable, rotate or delete; other clients stay valid', async () => {
    const f = await fixture({ initialized: true, authToken: 'startup-legacy-secret', apiKeys: [
        { id: 'regular', name: 'regular', secret: 'startup-regular-secret', enabled: true, scope: { allAgents: true, agentIds: [] } }
    ] })
    const auth = async (secret: string) => (await fetch(f.base + '/v1/meta', { headers: { Authorization: `Bearer ${secret}` } })).status
    try {
        await f.control.initializeAdminPassword('a-test-password', 'a-test-password')
        assert.equal(await auth('startup-legacy-secret'), 200)
        assert.equal(await auth('startup-regular-secret'), 200)
        await f.control.updateApiKey('legacy', { enabled: false })
        assert.equal(await auth('startup-legacy-secret'), 401)
        assert.equal(await auth('startup-regular-secret'), 200)
        await f.control.updateApiKey('legacy', { enabled: true })
        const rotated = await f.control.regenerateApiKey('legacy')
        assert.equal(await auth('startup-legacy-secret'), 401)
        assert.equal(await auth(rotated.secret), 200)
        await f.control.deleteApiKey('legacy')
        assert.equal(await auth(rotated.secret), 401)
        await f.control.updateApiKey('regular', { enabled: false })
        assert.equal(await auth('startup-regular-secret'), 401)
        await f.control.deleteApiKey('regular')
        assert.equal(await auth('startup-regular-secret'), 401)
    } finally { await f.close() }
})

test('scope rejects inherited names and empty catalog cannot create a constructor session', async () => {
    const f = await fixture()
    try {
        await f.control.initializeAdminPassword('a-test-password', 'a-test-password')
        await assert.rejects(f.control.createApiKey('bad scope', { allAgents: false, agentIds: ['constructor'] }), /Configured agent not found/)
        await assert.rejects(f.manager.create('constructor', undefined, 'owner'), /Configured agent not found/)
        assert.equal(f.manager.count(), 0)
    } finally { await f.close() }
})

test('session admission reserves before await and releases failed slots without restricting allowed cwd', async (t) => {
    const f = await fixture({ maxSessions: 1, agents: { codex: { driver: 'codex' } } })
    t.mock.method(AcpProcessRuntime.prototype, 'start', async () => {})
    try {
        await mkdir(path.join(f.directory, 'sibling'))
        const created = await Promise.allSettled(Array.from({ length: 20 }, () => f.manager.create('codex', path.join(f.directory, 'sibling'), 'owner')))
        assert.equal(created.filter((item) => item.status === 'fulfilled').length, 1)
        for (const result of created) if (result.status === 'rejected') assert.equal(result.reason.status, 429)
        assert.equal(f.manager.count(), 1)
        const first = created.find((item) => item.status === 'fulfilled') as PromiseFulfilledResult<any>
        assert.equal(first.value.workspace, path.join(f.directory, 'sibling'))
        await f.manager.close(first.value.id)
        await assert.rejects(f.manager.create('codex', path.join(f.directory, 'missing'), 'owner'))
        assert.equal(f.manager.count(), 0)
        assert.equal((await f.manager.create('codex', f.directory, 'owner')).workspace, f.directory)
    } finally { await f.close() }
})

test('readiness filters before probing, coalesces concurrent refresh, and applies cooldown', async () => {
    const f = await fixture({ agents: { visible: { driver: 'codex' }, hidden: { driver: 'codex' } } })
    const counts = { visible: 0, hidden: 0 }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const drivers = new Map(Object.keys(counts).map((id) => [id, { async probe() {
        counts[id as keyof typeof counts]++; await gate; return { id, name: id, protocol: 'acp', ready: true }
    } }]))
    f.manager.reconfigure(f.config, await WorkspacePolicy.create([f.directory]), drivers as any)
    try {
        const pending = Array.from({ length: 8 }, () => f.manager.listAgents(new Set(['visible']), true))
        release()
        for (const result of await Promise.all(pending)) assert.deepEqual(result.map((agent) => agent.id), ['visible'])
        await f.manager.listAgents(new Set(['visible']), true)
        assert.deepEqual(counts, { visible: 1, hidden: 0 })
        await f.manager.listAgents()
        assert.deepEqual(counts, { visible: 1, hidden: 1 })
    } finally { release(); await f.close() }
})

test('readiness caps parallel work and cannot publish an old configuration after reconfigure', async () => {
    const f = await fixture({ agents: Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['agent-' + i, { driver: 'codex' }])) })
    let active = 0
    let peak = 0
    const drivers = new Map(Object.keys(f.config.agents).map((id) => [id, { async probe() {
        active++; peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active--
        return { id, name: id, protocol: 'acp', ready: true }
    } }]))
    const policy = await WorkspacePolicy.create([f.directory])
    f.manager.reconfigure(f.config, policy, drivers as any)
    try {
        assert.equal((await f.manager.listAgents()).length, 9)
        assert.equal(peak, 4)
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        const changed = { ...f.config, agents: { only: { driver: 'codex' as const } } }
        f.manager.reconfigure(changed, policy, new Map([['only', { async probe() { await gate; return { id: 'only', name: 'old', ready: true } } }]]) as any)
        const old = f.manager.listAgents()
        const rejected = assert.rejects(old, /configuration changed/)
        f.manager.reconfigure({ ...changed, agents: { only: { driver: 'codex', enabled: false } } }, policy, new Map())
        release()
        await rejected
        const fresh = await f.manager.listAgents()
        assert.equal(fresh[0].ready, false)
        assert.equal(fresh[0].enabled, false)
    } finally { await f.close() }
})

test('concurrent login attempts are reserved before hashing; reveal is bounded and audited without secrets', async (t) => {
    const f = await fixture()
    const logs: string[] = []
    t.mock.method(console, 'info', (value: string) => { logs.push(value) })
    try {
        await f.control.initializeAdminPassword('a-test-password', 'a-test-password')
        const login = (password: string) => fetch(f.base + '/v1/admin/auth/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
        const signedIn = await login('a-test-password')
        const cookie = signedIn.headers.get('set-cookie')!
        const key = await f.control.createApiKey('client', { allAgents: true, agentIds: [] })
        for (let i = 0; i < 21; i++) {
            const response = await fetch(f.base + '/v1/admin/api-keys/' + key.key.id + '/reveal', { method: 'POST', headers: { Origin: f.base, Cookie: cookie } })
            assert.equal(response.status, i < 20 ? 200 : 429)
        }
        assert.equal(logs.length, 20)
        assert.equal(logs.join('').includes(key.secret), false)
        assert.match(logs[0], /api_key_revealed/)
        const attempts = await Promise.all(Array.from({ length: 20 }, () => login('wrong-password-value')))
        assert.equal(attempts.filter((response) => response.status === 401).length, 8)
        assert.equal(attempts.filter((response) => response.status === 429).length, 12)
    } finally { await f.close() }
})

test('SSE overflow unsubscribes and returns the real server connection slot', async (t) => {
    const f = await fixture({ maxSseConnections: 1, agents: { codex: { driver: 'codex' } } })
    t.mock.method(AcpProcessRuntime.prototype, 'start', async () => {})
    let response: Response | undefined
    let resumed: Response | undefined
    try {
        await f.control.initializeAdminPassword('a-test-password', 'a-test-password')
        const key = await f.control.createApiKey('client', { allAgents: true, agentIds: [] })
        const created = await f.manager.create('codex', f.directory, key.key.id)
        const headers = { Authorization: `Bearer ${key.secret}` }
        const url = f.base + '/v1/sessions/' + created.id + '/events'
        response = await fetch(url, { headers })
        assert.equal(response.status, 200)
        assert.equal((await fetch(url, { headers })).status, 429)
        const session = (f.manager as any).sessions.get(created.id)
        session.emit('assistant_chunk', { text: 'x'.repeat(600 * 1024) })
        resumed = await fetch(url + '?after=' + f.manager.get(created.id).lastEventId, { headers })
        assert.equal(resumed.status, 200)
    } finally {
        await response?.body?.cancel().catch(() => {})
        await resumed?.body?.cancel().catch(() => {})
        await f.close()
    }
})

class SlowResponse extends EventEmitter {
    writableLength = 0
    destroyed = false
    writableEnded = false
    blocked = true
    chunks: string[] = []
    write(chunk: string) { this.chunks.push(chunk); return !this.blocked }
}

async function observeSse(url: string, secret: string) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const state = { closed: false, text: '' }
    const finished = (async () => {
        try {
            for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                state.text += new TextDecoder().decode(value)
            }
        } catch { /* Revocation destroys the socket, which can reject the reader. */ }
        finally { state.closed = true }
    })()
    return { state, async close() { await reader.cancel().catch(() => {}); await finished },
        async waitClosed() {
            let timer: NodeJS.Timeout | undefined
            try {
                await Promise.race([finished, new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('SSE was not revoked')), 1000)
                })])
            } finally { clearTimeout(timer) }
        }
    }
}

test('Key revocation closes only affected SSE, retains running tasks, and rotation preserves Session ownership', async (t) => {
    const f = await fixture({ agents: { alpha: { driver: 'codex' }, beta: { driver: 'codex' } } })
    t.mock.method(AcpProcessRuntime.prototype, 'start', async () => {})
    const streams: Awaited<ReturnType<typeof observeSse>>[] = []
    const open = async (sessionId: string, secret: string) => {
        const stream = await observeSse(`${f.base}/v1/sessions/${sessionId}/events`, secret)
        streams.push(stream)
        return stream
    }
    try {
        await f.control.initializeAdminPassword('a-test-password', 'a-test-password')
        const one = await f.control.createApiKey('one', { allAgents: true, agentIds: [] })
        const two = await f.control.createApiKey('two', { allAgents: true, agentIds: [] })
        const alpha = await f.manager.create('alpha', f.directory, one.key.id)
        const beta = await f.manager.create('beta', f.directory, one.key.id)
        const other = await f.manager.create('alpha', f.directory, two.key.id)
        const managed = (f.manager as any).sessions.get(alpha.id)
        managed.setState('running')
        const a = await open(alpha.id, one.secret)
        const b = await open(beta.id, one.secret)
        const unaffected = await open(other.id, two.secret)
        await f.control.updateApiKey(one.key.id, { name: 'renamed' })
        assert.equal(a.state.closed, false)
        await f.control.updateApiKey(one.key.id, { scope: { allAgents: false, agentIds: ['alpha'] } })
        await b.waitClosed()
        assert.equal(a.state.closed, false)
        assert.equal(unaffected.state.closed, false)
        const rotated = await f.control.regenerateApiKey(one.key.id)
        await a.waitClosed()
        assert.equal(f.manager.get(alpha.id).state, 'running')
        assert.equal(f.manager.owns(alpha.id, rotated.key.id), true)
        assert.equal((await fetch(`${f.base}/v1/sessions/${alpha.id}`, { headers: { Authorization: `Bearer ${one.secret}` } })).status, 401)
        assert.equal((await fetch(`${f.base}/v1/sessions/${alpha.id}`, { headers: { Authorization: `Bearer ${rotated.secret}` } })).status, 200)
        const next = await open(alpha.id, rotated.secret)
        await f.control.updateApiKey(one.key.id, { enabled: false })
        await next.waitClosed()
        await f.control.updateApiKey(one.key.id, { enabled: true })
        const last = await open(alpha.id, rotated.secret)
        await f.control.deleteApiKey(one.key.id)
        await last.waitClosed()
        assert.equal(f.manager.get(alpha.id).state, 'running')
        assert.equal(unaffected.state.closed, false)
        assert.equal((await fetch(`${f.base}/v1/sessions/${alpha.id}`, { headers: { Authorization: `Bearer ${two.secret}` } })).status, 404)
        assert.equal((f.control as any).keyWatchers.size, 1)
    } finally {
        await Promise.all(streams.map((stream) => stream.close()))
        await f.close()
    }
})

test('SSE reset advertises bounded snapshot recovery and snapshot cursor resumes live events', async (t) => {
    const f = await fixture({ maxEventsPerSession: 64, agents: { codex: { driver: 'codex' } } })
    t.mock.method(AcpProcessRuntime.prototype, 'start', async () => {})
    try {
        await f.control.initializeAdminPassword('a-test-password', 'a-test-password')
        const key = await f.control.createApiKey('client', { allAgents: true, agentIds: [] })
        const session = await f.manager.create('codex', f.directory, key.key.id)
        const managed = (f.manager as any).sessions.get(session.id)
        managed.appendOutput('x'.repeat(600_000))
        for (let n = 0; n < 80; n++) managed.emit('assistant_chunk', { text: String(n) })
        const headers = { Authorization: `Bearer ${key.secret}` }
        const response = await fetch(`${f.base}/v1/sessions/${session.id}/events?after=0`, { headers })
        const reader = response.body!.getReader()
        const frame = new TextDecoder().decode((await reader.read()).value)
        assert.match(frame, /event: reset/)
        assert.ok(frame.length < 1000)
        const reset = JSON.parse(frame.split('data: ')[1].split('\n')[0])
        assert.equal(reset.reason, 'expired')
        assert.equal(reset.latestId, f.manager.get(session.id).lastEventId)
        const snapshot = await (await fetch(f.base + reset.snapshotUrl, { headers })).json() as any
        assert.equal(snapshot.id, session.id)
        assert.ok(snapshot.output.length > 512 * 1024)
        await reader.cancel()
        const resumed = await fetch(`${f.base}/v1/sessions/${session.id}/events`, { headers: { ...headers, 'Last-Event-ID': snapshot.lastEventId } })
        const resumedReader = resumed.body!.getReader()
        managed.emit('assistant_chunk', { text: 'after-reconnect' })
        const live = new TextDecoder().decode((await resumedReader.read()).value)
        assert.match(live, /after-reconnect/)
        assert.doesNotMatch(live, /event: reset/)
        await resumedReader.cancel()
    } finally { await f.close() }
})

test('SSE bounds a slow consumer and releases once; legitimate drain preserves exact order', async () => {
    const slow = new SlowResponse()
    let closed = 0
    const writer = createSseWriter(slow as any, () => closed++, 10, 20)
    assert.equal(writer.write('one'), true)
    assert.equal(writer.write('two'), true)
    assert.equal(writer.write('01234567890'), false)
    writer.write('ignored')
    assert.equal(closed, 1)
    assert.equal(slow.listenerCount('drain'), 0)

    const normal = new SlowResponse()
    const flowing = createSseWriter(normal as any, () => { throw new Error('unexpected close') }, 100, 100)
    flowing.write('a'); flowing.write('b'); flowing.write('c')
    assert.deepEqual(normal.chunks, ['a'])
    normal.blocked = false; normal.emit('drain')
    assert.deepEqual(normal.chunks, ['a', 'b', 'c'])
    flowing.stop()

    const deadline = createSseWriter(new SlowResponse() as any, () => closed++, 100, 10)
    deadline.write('a')
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(closed, 2)
    deadline.stop()
})

test('shutdown attempts every Session and propagates disposal failures to the caller', async () => {
    const f = await fixture()
    const disposed: string[] = []
    const sessions = (f.manager as any).sessions as Map<string, unknown>
    sessions.set('bad', { interruptForShutdown() {}, async dispose() { disposed.push('bad'); throw new Error('cleanup failed') } })
    sessions.set('good', { interruptForShutdown() {}, async dispose() { disposed.push('good') } })
    try {
        await assert.rejects(f.manager.shutdown(), (error: unknown) => {
            assert.ok(error instanceof AggregateError)
            assert.match(error.errors[0].message, /cleanup failed/)
            return true
        })
        assert.deepEqual(disposed.sort(), ['bad', 'good'])
        assert.equal(f.manager.count(), 0)
    } finally { await f.close() }
})
