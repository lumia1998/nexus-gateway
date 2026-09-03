import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Role, TaskState } from '@a2a-js/sdk'
import { AcpProcessRuntime } from '../src/acp/runtime.js'
import { A2AClientRuntime } from '../src/a2a/runtime.js'
import { startAgentd } from '../src/index.js'
import { ManagedSession, SessionManager, SessionRequestError } from '../src/session.js'
import { WorkspacePolicy } from '../src/workspace.js'
import type { AgentdConfig } from '../src/types.js'

// Deployment targets Linux. Windows taskkill has no guaranteed fallback;
// exercise real process teardown on the supported platform instead.
const posixOnly = { skip: process.platform === 'win32' ? 'Requires supported POSIX process teardown' : false }

function session(protocol: 'acp' | 'a2a' = 'acp', workspace = process.cwd()) {
    return new ManagedSession('test', protocol, workspace, 'owner', 64, 64 * 1024, 'Test')
}

function runtimeStub() {
    return { async start() {}, async prompt() {}, async respondPending() {}, async cancel() {}, async dispose() {} }
}

async function within<T>(promise: Promise<T>, ms = 3000) {
    let timer: NodeJS.Timeout
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('test deadline exceeded')), ms)
        })])
    } finally { clearTimeout(timer!) }
}

async function until(check: () => boolean) {
    await within((async () => { while (!check()) await new Promise((resolve) => setTimeout(resolve, 5)) })())
}

for (const mode of ['hang-initialize', 'hang-session', 'ready']) {
    test(`ACP startup bounds ${mode} and disposes its real child process`, posixOnly, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-startup-'))
        let child: ReturnType<typeof spawn> | undefined
        const state = session('acp', directory)
        const driver = {
            id: 'test', name: 'Test', command: process.execPath, args: [], env: {},
            permissionPolicy: 'ask' as const, permissionTimeoutMs: 1000,
            ownsProcessGroup: process.platform !== 'win32',
            async probe() { throw new Error('unused') },
            spawn() {
                child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/acp-handshake.mjs', import.meta.url)), mode],
                    { stdio: 'pipe', detached: process.platform !== 'win32', windowsHide: true })
                return child as any
            }
        }
        const runtime = new AcpProcessRuntime(driver, state, 1024, 10_000, [directory], mode === 'ready' ? 2000 : 300)
        try {
            if (mode === 'ready') {
                await within(runtime.start(directory))
                assert.equal(state.acpSessionId, 'test-session')
                assert.equal(runtime.isAvailable(), true)
                await assert.rejects(() => runtime.start(directory), /already started/)
                assert.equal(runtime.isAvailable(), true)
                await runtime.dispose()
            } else {
                await assert.rejects(() => within(runtime.start(directory), 5000), /ACP startup timed out/)
                assert.equal(state.state, 'failed')
                assert.equal(state.acpSessionId, undefined)
            }
            assert.equal(runtime.isAvailable(), false)
            assert.ok(child && (child.exitCode !== null || child.signalCode !== null))
        } finally {
            await runtime.dispose()
            child?.kill('SIGKILL')
            await rm(directory, { recursive: true, force: true })
        }
    })
}

test('ACP still kills its process and removes inputs when connection.close throws', posixOnly, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-dispose-'))
    const inputs = path.join(directory, 'inputs')
    await mkdir(inputs)
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'pipe', windowsHide: true })
    const state = session()
    const runtime = new AcpProcessRuntime({ ownsProcessGroup: false } as any, state)
    Object.assign(runtime, { process: child, inputDirectory: inputs, connection: { close() { throw new Error('injected close failure') } } })
    try {
        await within(runtime.dispose(), 5000)
        assert.ok(child.exitCode !== null || child.signalCode !== null)
        await assert.rejects(() => access(inputs))
        assert.ok(state.events.after().some((event) => JSON.stringify(event).includes('injected close failure')))
    } finally {
        child.kill('SIGKILL')
        await rm(directory, { recursive: true, force: true })
    }
})

test('canceled or unavailable runtimes reject new messages before creating work', async () => {
    for (const protocol of ['acp', 'a2a'] as const) {
        let prompts = 0
        let disposed = false
        const state = session(protocol)
        state.attach({ ...runtimeStub(), async prompt() { prompts++ }, async dispose() { disposed = true } })
        await state.cancel()
        assert.equal(state.state, 'canceled')
        assert.equal(disposed, true)
        await assert.rejects(() => state.message('Do not accept'), (error: unknown) => error instanceof SessionRequestError && error.status === 409)
        assert.equal(prompts, 0)
        const unavailable = session(protocol)
        unavailable.attach({ ...runtimeStub(), isAvailable: () => false, async prompt() { prompts++ } })
        await assert.rejects(() => unavailable.message('Do not accept'), /runtime is unavailable/)
        assert.equal(prompts, 0)
    }
})

test('cleanup continues after one disposal rejects and the timer does not leak a rejection', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-cleanup-'))
    const policy = await WorkspacePolicy.create([directory])
    const manager = new SessionManager({ sessionTtlMs: 1, cleanupIntervalMs: 5 } as AgentdConfig, policy, new Map())
    const errors: unknown[] = []
    t.mock.method(console, 'error', (value: unknown) => errors.push(value))
    const first = session(), second = session()
    first.updatedAt = second.updatedAt = 0
    first.attach({ ...runtimeStub(), async dispose() { throw new Error('injected dispose failure') } })
    second.attach(runtimeStub())
    ;(manager as any).sessions.set(first.id, first)
    ;(manager as any).sessions.set(second.id, second)
    try {
        manager.startCleanup()
        await until(() => manager.count() === 0)
        assert.ok(errors.some((value) => String(value).includes('injected dispose failure')))
    } finally {
        await manager.shutdown()
        await rm(directory, { recursive: true, force: true })
    }
})

for (const cancel of [false, true]) {
    test(`A2A pending input releases the session lock before the stream ends (cancel=${cancel})`, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-a2a-resume-'))
        const manager = new SessionManager({ sessionTtlMs: 60_000 } as AgentdConfig, await WorkspacePolicy.create([directory]), new Map())
        const state = session('a2a')
        const runtime = new A2AClientRuntime({ protocol: 'a2a', agentUrl: 'http://localhost', timeoutMs: 5000 }, state, 5000)
        let release!: () => void
        const stream = new Promise<void>((resolve) => { release = resolve })
        let calls = 0
        Object.assign(runtime, { card: { defaultOutputModes: ['text/plain'] }, client: {
            async *sendMessageStream() {
                if (++calls === 1) {
                    yield { payload: { $case: 'statusUpdate', value: { taskId: 'task', contextId: 'context', status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } } } }
                    await stream
                    yield { payload: { $case: 'statusUpdate', value: { taskId: 'task', contextId: 'context', status: { state: TaskState.TASK_STATE_INPUT_REQUIRED } } } }
                } else yield { payload: { $case: 'message', value: { messageId: 'done', role: Role.ROLE_AGENT, parts: [{ content: { $case: 'text', value: 'Done' } }] } } }
            }, async cancelTask() {}
        } })
        state.attach(runtime)
        ;(manager as any).sessions.set(state.id, state)
        try {
            await manager.message(state.id, 'Start')
            await until(() => Boolean(state.pendingRequest))
            const accepted = await within(manager.resolvePending(state.id, { requestId: state.pendingRequest!.id, message: 'Continue' }), 500)
            assert.equal(accepted.state, 'running')
            assert.equal(calls, 1)
            if (cancel) await within(manager.cancel(state.id), 500)
            release()
            if (cancel) {
                await new Promise((resolve) => setTimeout(resolve, 20))
                assert.equal(calls, 1)
                assert.equal(state.state, 'canceled')
            } else {
                await until(() => state.state === 'completed')
                assert.equal(calls, 2)
                assert.equal(state.output, 'Done')
            }
            assert.equal(state.events.after().filter((event) => event.type === 'input_required').length, 1)
        } finally {
            release()
            await manager.shutdown()
            await rm(directory, { recursive: true, force: true })
        }
    })
}

test('a server error after listening closes sessions instead of becoming unhandled', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-server-error-'))
    const configPath = path.join(directory, 'config.json')
    const reservation = createServer()
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()))
    await writeFile(configPath, JSON.stringify({ initialized: false, listen: { host: '127.0.0.1', port }, workspaceRoots: [directory], agents: {} }))
    t.mock.method(console, 'error', () => undefined)
    const gateway = await startAgentd(configPath)
    try {
        const state = session()
        let disposed = false
        state.attach({ ...runtimeStub(), async dispose() { disposed = true } })
        ;(gateway.sessions as any).sessions.set(state.id, state)
        gateway.server.emit('error', new Error('injected server error'))
        await gateway.close()
        assert.equal(disposed, true)
        assert.equal(gateway.server.listening, false)
    } finally {
        await gateway.close()
        await rm(directory, { recursive: true, force: true })
    }
})
