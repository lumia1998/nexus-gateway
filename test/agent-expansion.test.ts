import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { AcpProcessRuntime } from '../src/acp/runtime.js'
import { CliProcessRuntime } from '../src/cli-runtime.js'
import { ManagedSession, SessionManager } from '../src/session.js'
import { loadAgentdConfig } from '../src/config.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import { RunStore } from '../src/run-store.js'
import { WorkspacePolicy } from '../src/workspace.js'
import type { AgentDriver } from '../src/drivers/types.js'
import { selectionValue, findOption } from '../src/acp/selection.js'

const fixture = fileURLToPath(new URL('./fixtures/acp-configurable.mjs', import.meta.url))

test('model identifiers preserve product encodings and ambiguous names cannot select the wrong model', () => {
    const option = (values: string[]) => ({ id: 'model', name: 'Model', type: 'select', currentValue: values[0], options: values.map(value => ({ value, name: value })) }) as any
    assert.equal(selectionValue('zcode', option(['provider\\model']), 'provider/model'), 'provider\\model')
    assert.throws(() => selectionValue('zcode', option(['a\\model', 'b\\model']), 'model'), /Unsupported/)
    assert.equal(selectionValue('minimax', option(['m:provider:model:v:fast']), 'provider/model#fast'), 'm:provider:model:v:fast')
    assert.equal(selectionValue('kimi', { id: 'thinking', type: 'boolean', currentValue: false } as any, 'on'), true)
    assert.equal(findOption([{ id: 'permissionMode', category: 'mode' } as any], 'mode'), undefined)
})
function driver(kind = 'kimi', overrides = {}): AgentDriver {
    return { id: 'test', kind: kind as any, name: 'Test', command: process.execPath, args: [fixture], env: {}, permissionPolicy: 'ask', permissionTimeoutMs: 2000,
        config: { driver: kind as any, stallTimeoutMs: 500, idleUnloadMs: 1 }, ownsProcessGroup: process.platform !== 'win32',
        probe: async () => ({ id: 'test', name: 'Test', protocol: 'acp', ready: true }),
        spawn: (_workspace, _options, args) => spawn(process.execPath, args || [fixture], { stdio: 'pipe', detached: process.platform !== 'win32', windowsHide: true }), ...overrides }
}
function session() { return new ManagedSession('test', 'acp', process.cwd(), 'owner', 64, 65536, 'Test') }
async function until(check: () => boolean) {
    const end = Date.now() + 6000
    while (!check()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)) }
}

test('ACP switches model before validating the new thinking vocabulary, restores and unloads without losing ID', async () => {
    const sink = session(), runtime = new AcpProcessRuntime(driver(), sink, 1024, 10_000, [], 3000, { model: 'test/model-b', effort: 'max', permissionPolicy: 'bypass' })
    sink.attach(runtime)
    try {
        await runtime.start(process.cwd())
        assert.equal(runtime.view().resumable, true)
        await runtime.prompt('hello')
        assert.equal(sink.output, 'test/model-b max yolo')
        assert.equal(sink.state, 'completed')
        const native = sink.acpSessionId
        assert.equal(await runtime.suspend(), true)
        assert.equal(runtime.view().status, 'suspended')
        assert.equal(runtime.isAvailable(), true)
        await sink.message('second turn')
        await until(() => sink.state === 'completed')
        assert.equal(sink.acpSessionId, native)
        assert.equal(sink.output, 'test/model-b max yolo')
        await assert.rejects(runtime.configure({ effort: 'medium' }), /Unsupported/)
        assert.equal(runtime.view().options.effort, 'max')
    } finally { await runtime.dispose() }
})

test('remote caller can answer permission; auto accepts an offered permanent grant without a pending UI request', async () => {
    for (const policy of ['ask', 'auto'] as const) {
        const sink = session(), runtime = new AcpProcessRuntime(driver(), sink, 1024, 10_000, [], 3000, { permissionPolicy: policy })
        try {
            await runtime.start(process.cwd())
            const turn = runtime.prompt('permission')
            if (policy === 'ask') {
                await until(() => Boolean(sink.pendingRequest))
                await new Promise(resolve => setTimeout(resolve, 600)) // longer than stall budget: waiting is not a stall
                assert.equal(sink.state, 'permission_required')
                await runtime.respondPending({ requestId: sink.pendingRequest!.id, optionId: 'always' })
            }
            await turn
            assert.equal(sink.state, 'completed')
            assert.equal(sink.pendingRequest, undefined)
            if (policy === 'auto') assert.ok(sink.events.after().some(event => event.type === 'permission_decision'))
        } finally { await runtime.dispose() }
    }
})

test('stalled ACP releases the process, and missing native sessions never silently become new ones', async () => {
    const sink = session(), runtime = new AcpProcessRuntime(driver(), sink, 1024, 10_000, [], 3000)
    try {
        await runtime.start(process.cwd())
        await runtime.prompt('hang')
        assert.equal(sink.state, 'failed')
        assert.match(sink.error!, /stalled/)
        assert.equal(runtime.isAvailable(), false)
    } finally { await runtime.dispose() }
    const missing = session()
    missing.setAcpSessionId('missing')
    const restore = new AcpProcessRuntime(driver(), missing, 1024, 10_000, [], 3000)
    await assert.rejects(restore.start(process.cwd()), /Missing session/)
    assert.equal(missing.acpSessionId, 'missing')
    assert.equal(restore.isAvailable(), false)
})

test('native CLI requires explicit unattended policy and a real completion event', async () => {
    for (const mode of ['codex', 'agy', 'incomplete', 'hang']) {
        const sink = session()
        const nativeFixture = fileURLToPath(new URL('./fixtures/native-jsonl.mjs', import.meta.url))
        const nativeDriver = driver(mode === 'agy' ? 'antigravity' : 'codex-cli', {
            spawn: () => spawn(process.execPath, [nativeFixture, mode], { stdio: 'pipe', detached: process.platform !== 'win32', windowsHide: true })
        })
        const runtime = new CliProcessRuntime(nativeDriver, sink, 2000, { permissionPolicy: 'bypass' })
        try {
            await assert.rejects(new CliProcessRuntime(nativeDriver, sink, 2000).start(process.cwd()), /requires permissionPolicy/)
            await runtime.start(process.cwd())
            await runtime.prompt('test')
            assert.equal(sink.state, mode === 'incomplete' || mode === 'hang' ? 'failed' : 'completed')
            if (mode === 'incomplete') assert.match(sink.error!, /completion event/)
            if (sink.state === 'completed') {
                assert.equal(runtime.view().status, 'suspended', 'completion must be published only after the process is released')
                const id = sink.protocolSessionId
                await runtime.prompt('next task')
                assert.equal(sink.state, 'completed')
                assert.equal(sink.protocolSessionId, id)
            }
        } finally { await runtime.dispose() }
    }
})

test('catalog, persistent logs and explicit context restoration survive gateway restart with owner isolation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-expansion-'))
    const file = path.join(directory, 'config.json')
    const history = path.join(directory, 'runs.json')
    let manager: SessionManager | undefined
    let store: RunStore | undefined
    try {
        const agents = Object.fromEntries(['kimi', 'cursor', 'devin', 'zcode', 'minimax', 'antigravity', 'codex-cli'].map(driver => [driver, { driver, workspace: directory }]))
        agents.kimi = { ...agents.kimi, command: process.execPath, args: [fixture], permissionPolicy: 'auto', idleUnloadMs: 1 } as any
        await writeFile(file, JSON.stringify({ initialized: false, listen: { host: '127.0.0.1', port: 8787 }, workspaceRoots: [directory], agents }))
        const config = await loadAgentdConfig(file)
        const registry = createDriverRegistry(config)
        assert.equal(registry.size, 7)
        assert.equal(registry.get('antigravity')?.protocol, 'cli')
        store = new RunStore(history); await store.init()
        const workspace = await WorkspacePolicy.create([directory])
        manager = new SessionManager(config, workspace, registry, store)
        const created = await manager.create('kimi', directory, 'owner', { model: 'test/model-b', effort: 'max' })
        const first = await manager.message(created.id, 'hello')
        await until(() => manager!.get(created.id).state === 'completed')
        assert.ok(store.get(first.runId!)!.events!.length)
        await manager.shutdown(); await store.flush()
        store = new RunStore(history); await store.init()
        manager = new SessionManager(config, workspace, createDriverRegistry(config), store)
        await assert.rejects(manager.resumeRun(first.runId!, 'other'), /Run not found/)
        const restored = await manager.resumeRun(first.runId!, 'owner')
        assert.notEqual(restored.id, created.id)
        assert.equal(restored.protocolSessionId, created.protocolSessionId)
        assert.equal(restored.runtime?.options.effort, 'max')
        assert.equal(store.list().total, 1, 'restore must not replay the old prompt')
        await manager.message(restored.id, 'follow up')
        await until(() => manager!.get(restored.id).state === 'completed')
        assert.equal(store.list().total, 2)
        await new Promise(resolve => setTimeout(resolve, 20))
        await (manager as any).cleanup()
        assert.equal(manager.get(restored.id).runtime?.status, 'suspended')
    } finally {
        await manager?.shutdown(); await store?.flush()
        await rm(directory, { recursive: true, force: true })
    }
})
