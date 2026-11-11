import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadAgentdConfig } from '../src/config.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import { createAgentdServer } from '../src/server.js'
import { closeServer } from '../src/index.js'
import { SessionManager } from '../src/session.js'
import { WorkspacePolicy } from '../src/workspace.js'
import { RunStore } from '../src/run-store.js'
import { McpDispatchStore } from '../src/mcp/dispatch-store.js'
import { readAcpText, writeAcpText } from '../src/acp/filesystem.js'

async function fixture() {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-mcp-'))
    const configFile = path.join(directory, 'config.json')
    const key = randomUUID(), otherKey = randomUUID(), scopedKey = randomUUID()
    const worker = fileURLToPath(new URL('./fixtures/mcp-worker.mjs', import.meta.url))
    await writeFile(configFile, JSON.stringify({ listen: { host: '127.0.0.1', port: 8787 }, workspaceRoots: [directory],
        apiKeys: [
            { id: 'owner', name: 'Owner', secret: key, enabled: true, scope: { allAgents: true, agentIds: [] } },
            { id: 'other', name: 'Other', secret: otherKey, enabled: true, scope: { allAgents: true, agentIds: [] } },
            { id: 'limited', name: 'Limited', secret: scopedKey, enabled: true, scope: { allAgents: false, agentIds: ['gemini'] } }
        ], quotas: { maxRunningRunsPerKey: 1 },
        agents: { claude: { driver: 'claude', command: process.execPath, args: [worker], probeArgs: [worker, '--version'] },
            gemini: { driver: 'gemini', command: process.execPath, args: [worker], probeArgs: [worker, '--version'] } }
    }))
    const config = await loadAgentdConfig(configFile)
    const history = path.join(directory, 'runs.json')
    let store: RunStore, sessions: SessionManager, server: ReturnType<typeof createAgentdServer>, base: string
    const start = async () => {
        store = new RunStore(history); await store.init()
        sessions = new SessionManager(config, await WorkspacePolicy.create([directory]), createDriverRegistry(config), store)
        server = createAgentdServer(config, sessions)
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    await start()
    const clients: Client[] = []
    const connect = async (token = key) => {
        const client = new Client({ name: 'integration', version: '1.0.0' }, { capabilities: {} })
        await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
        clients.push(client)
        return client
    }
    const stop = async () => {
        await Promise.all(clients.splice(0).map(client => client.close()))
        await closeServer(server); await sessions.shutdown(); await store.flush()
    }
    return {
        directory, config, key, otherKey, scopedKey, connect,
        get base() { return base }, get sessions() { return sessions }, get store() { return store },
        async restart() { await stop(); await start() },
        async close() { await stop(); await rm(directory, { recursive: true, force: true }) }
    }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}, expectError = false) {
    const result = await client.callTool({ name, arguments: args }) as any
    const body = result.structuredContent || JSON.parse(result.content[0].text)
    assert.equal(Boolean(result.isError), expectError, JSON.stringify(body))
    return body
}

test('real MCP SDK discovers five tools and delegates the intact message to the remote default model', async () => {
    const f = await fixture()
    try {
        const client = await f.connect()
        assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['cancel_task', 'dispatch_task', 'get_task', 'list_agents', 'respond_task'].sort())
        assert.match(client.getInstructions()!, /Omit options/)
        const inventory = await call(client, 'list_agents')
        assert.equal(inventory.agents.length, 2)
        assert.equal(inventory.agents[0].defaults.options.model, undefined)
        const capabilities = await call(client, 'list_agents', { agent_id: 'claude', include_capabilities: true })
        assert.equal(capabilities.capabilities.configOptions[0].currentValue, 'remote-default')
        assert.equal(f.sessions.count(), 0, 'capability discovery must release its process and slot')
        const message = '  Opus 负责这项任务，并创建两个 Sonnet 子 Agent 分别检查前端和后端。\n请自行组织团队。  '
        const args = { agent_id: 'claude', message, request_id: randomUUID() }
        const [first, duplicate] = await Promise.all([call(client, 'dispatch_task', args), call(client, 'dispatch_task', args)])
        assert.equal(first.task_id, duplicate.task_id)
        const persisted = JSON.parse(await readFile(path.join(f.directory, 'runs.json'), 'utf8'))
        assert.ok(persisted.runs.some((run: any) => run.id === first.task_id), 'successful receipt must reference persisted history')
        const done = await call(client, 'get_task', { task_id: first.task_id, wait_seconds: 5, include_logs: true })
        assert.equal(done.state, 'completed')
        assert.deepEqual(JSON.parse(done.output), { message, model: 'remote-default', mode: 'default', effort: 'low', promptCount: 1 })
        assert.equal(f.store.list().total, 1, 'team text must not create gateway children')
        await call(client, 'dispatch_task', { ...args, message: 'different' }, true)
        const explicit = await call(client, 'dispatch_task', { agent_id: 'claude', session_id: first.session_id, request_id: randomUUID(), message: 'Next', options: { model: 'explicit-model', effort: 'high' } })
        const next = await call(client, 'get_task', { task_id: explicit.task_id, wait_seconds: 5 })
        assert.equal(JSON.parse(next.output).model, 'explicit-model')
        assert.equal(JSON.parse(next.output).effort, 'high')
        const paged = await call(client, 'get_task', { task_id: first.task_id, output_limit: 8 })
        assert.equal(paged.output.length, 8)
        assert.equal(paged.next_output_offset, 8)
        const other = await f.connect(f.otherKey)
        await call(other, 'get_task', { task_id: first.task_id }, true)
        await call(other, 'cancel_task', { task_id: first.task_id }, true)
        const limited = await f.connect(f.scopedKey)
        assert.deepEqual((await call(limited, 'list_agents')).agents.map((agent: any) => agent.agent_id), ['gemini'])
        await call(limited, 'dispatch_task', { agent_id: 'claude', message: 'no', request_id: randomUUID() }, true)
        await f.restart()
        const restarted = await f.connect()
        const recovered = await call(restarted, 'dispatch_task', args)
        assert.equal(recovered.task_id, first.task_id)
        assert.equal(recovered.reused, true)
        assert.equal(f.sessions.count(), 0)
        const resumed = await call(restarted, 'dispatch_task', { agent_id: 'claude', resume_task_id: explicit.task_id, message: 'continue after restart', request_id: randomUUID() })
        assert.equal((await call(restarted, 'get_task', { task_id: resumed.task_id, wait_seconds: 5 })).state, 'completed')
    } finally { await f.close() }
})

test('MCP returns pending decisions, bounds waiting, cancels explicitly and keeps tasks alive when clients disconnect', async () => {
    const f = await fixture()
    try {
        let client = await f.connect()
        const permission = await call(client, 'dispatch_task', { agent_id: 'claude', message: 'permission', request_id: randomUUID() })
        const waiting = await call(client, 'get_task', { task_id: permission.task_id, wait_seconds: 5 })
        assert.equal(waiting.state, 'permission_required')
        await call(client, 'respond_task', { task_id: permission.task_id, request_id: 'stale', option_id: 'once' }, true)
        await call(client, 'respond_task', { task_id: permission.task_id, request_id: waiting.pending_request.id, option_id: 'once' })
        assert.equal((await call(client, 'get_task', { task_id: permission.task_id, wait_seconds: 5 })).state, 'completed')
        const hang = await call(client, 'dispatch_task', { agent_id: 'claude', session_id: permission.session_id, message: 'hang', request_id: randomUUID() })
        const poll = await call(client, 'get_task', { task_id: hang.task_id, wait_seconds: 1 })
        assert.equal(poll.state, 'running')
        assert.equal(poll.wait_timed_out, true)
        await call(client, 'cancel_task', { task_id: permission.task_id })
        assert.equal(f.sessions.get(hang.session_id).state, 'running', 'old run must not cancel a new turn')
        const controller = new AbortController()
        const disconnectedWait = fetch(f.base + '/mcp', {
            method: 'POST', signal: controller.signal,
            headers: { Authorization: `Bearer ${f.key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'get_task', arguments: { task_id: hang.task_id, wait_seconds: 30 } } })
        })
        setTimeout(() => controller.abort(), 100)
        await assert.rejects(disconnectedWait, /abort/i)
        assert.equal(f.sessions.get(hang.session_id).state, 'running', 'disconnect during long poll must not cancel worker')
        await client.close()
        assert.equal(f.sessions.get(hang.session_id).state, 'running')
        client = await f.connect()
        await call(client, 'cancel_task', { task_id: hang.task_id })
        assert.equal((await call(client, 'get_task', { task_id: hang.task_id })).state, 'canceled')
        const gemini = await call(client, 'dispatch_task', { agent_id: 'gemini', message: 'gemini-file', request_id: randomUUID() })
        assert.equal((await call(client, 'get_task', { task_id: gemini.task_id, wait_seconds: 5 })).output, 'gemini filesystem works')
        assert.equal(await readFile(path.join(f.directory, 'gemini-test.txt'), 'utf8'), 'gemini filesystem works')
    } finally { await f.close() }
})

test('MCP HTTP requires API auth, validates Host/Origin, rejects legacy transports and observes key revocation', async () => {
    const f = await fixture()
    try {
        const request = (headers: Record<string, string> = {}, method = 'POST', body = '{}') => fetch(f.base + '/mcp', {
            method, headers: { Authorization: `Bearer ${f.key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
            body: method === 'POST' ? body : undefined
        })
        assert.equal((await request({ Authorization: '' })).status, 401)
        assert.equal((await request({ Origin: 'https://evil.example' })).status, 403)
        const badHost = await new Promise<number>(resolve => {
            const raw = http.request(f.base + '/mcp', { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${f.key}`, 'Content-Type': 'application/json' } }, response => {
                response.resume(); resolve(response.statusCode!)
            })
            raw.end('{}')
        })
        assert.equal(badHost, 403)
        assert.equal((await request({}, 'GET')).status, 405)
        assert.equal((await request({}, 'DELETE')).status, 405)
        assert.equal((await request({}, 'POST', 'x'.repeat(f.config.maxRequestBytes + 1))).status, 413)
        const client = await f.connect()
        const job = await call(client, 'dispatch_task', { agent_id: 'claude', message: 'hang', request_id: randomUUID() })
        const pending = client.callTool({ name: 'get_task', arguments: { task_id: job.task_id, wait_seconds: 5 } }) as Promise<any>
        setTimeout(() => { f.config.apiKeys!.find(key => key.id === 'owner')!.enabled = false }, 100)
        const response = await pending
        assert.equal(response.isError, true)
        assert.match(response.content[0].text, /Invalid API Key/)
        assert.equal(f.sessions.get(job.session_id).state, 'running')
    } finally { await f.close() }
})

test('durable uncertain dispatch never replays and workspace file callbacks reject escapes', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-mcp-receipt-'))
    try {
        const file = path.join(directory, 'receipts.json')
        let release!: () => void
        const store = new McpDispatchStore(file)
        const active = store.once('owner', 'request-id', { message: 'task' }, async () => { await new Promise<void>(resolve => { release = resolve }); return { taskId: 'task', sessionId: 'session' } })
        while (!release) await new Promise(resolve => setTimeout(resolve, 5))
        let ran = false
        await assert.rejects(new McpDispatchStore(file).once('owner', 'request-id', { message: 'task' }, async () => { ran = true; return { taskId: 'bad', sessionId: 'bad' } }), /uncertain/)
        assert.equal(ran, false)
        release(); await active
        const duplicate = await new McpDispatchStore(file).once('owner', 'request-id', { message: 'task' }, async () => { throw new Error('must not run') })
        assert.equal(duplicate.task_id, 'task')
        // Match SessionManager's canonical workspace contract. Windows runners may
        // spell TEMP differently from realpath (drive casing / short aliases).
        const canonicalWorkspace = await realpath(directory)
        await assert.rejects(writeAcpText(canonicalWorkspace, '../outside.txt', 'no'), /outside/)
        await writeAcpText(canonicalWorkspace, 'text.txt', 'one\ntwo\nthree')
        assert.deepEqual(await readAcpText(canonicalWorkspace, 'text.txt', 2, 1), { content: 'two' })
        await assert.rejects(readAcpText(canonicalWorkspace, '../outside.txt'), /outside|ENOENT/)
    } finally { await rm(directory, { recursive: true, force: true }) }
})

test('history write failure after acceptance keeps the running task and its quota', async () => {
    const f = await fixture()
    const flush = f.sessions.flushRuns.bind(f.sessions)
    try {
        const client = await f.connect()
        f.sessions.flushRuns = async () => { throw new Error('injected write failure') }
        const args = { agent_id: 'claude', message: 'hang', request_id: randomUUID() }
        const failed = await call(client, 'dispatch_task', args, true)
        assert.match(failed.error, /Task accepted/)
        const [run] = f.store.list().runs
        assert.equal(run.state, 'running')
        assert.equal(f.sessions.count(), 1)
        f.sessions.flushRuns = flush
        const rejected = await call(client, 'dispatch_task', { agent_id: 'gemini', message: 'do not run', request_id: randomUUID() }, true)
        assert.match(rejected.error, /Quota exceeded/)
        assert.equal(f.sessions.count(), 1)
        await call(client, 'dispatch_task', args, true)
        assert.equal(f.store.list().total, 1)
        await call(client, 'cancel_task', { task_id: run.id })
    } finally { f.sessions.flushRuns = flush; await f.close() }
})
