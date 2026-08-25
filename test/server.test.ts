import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { ControlPlaneError } from '../src/control-plane.js'
import { createAgentdServer } from '../src/server.js'
import type { AgentdConfig } from '../src/types.js'

test('gateway requires bearer auth and rejects client supplied command/argv', async () => {
    let createCalls = 0
    const sessions = {
        async listAgents() {
            return []
        },
        async create() {
            createCalls += 1
            return {}
        }
    } as any
    const server = createAgentdServer(config(), sessions)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
        const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/agents`)
        assert.equal(unauthorized.status, 401)

        const agents = await fetch(`http://127.0.0.1:${port}/v1/agents`, {
            headers: { Authorization: 'Bearer test-token' }
        })
        assert.equal(agents.status, 200)

        const injection = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-token',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'opencode',
                workspace: '/tmp/project',
                command: 'sh',
                argv: ['-c', 'PAYLOAD']
            })
        })
        assert.equal(injection.status, 400)
        assert.match(await injection.text(), /Unsupported request fields/)
        assert.equal(createCalls, 0)
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

test('gateway serves its control deck and protects agent configuration writes', async () => {
    const calls: Array<{ id: string; input: unknown }> = []
    let accessKey = 'test-token'
    let workspaceRoots = ['/repos']
    const sessions = {
        async listAgents() {
            return []
        },
        async create(agentId: string, workspace?: string) {
            return { agentId, workspace }
        }
    } as any
    const controlPlane = {
        isInitialized() {
            return true
        },
        accessKey() {
            return accessKey
        },
        snapshot() {
            return { workspaceRoots, driverKinds: ['codex'], agents: [] }
        },
        async putAgent(id: string, input: unknown) {
            calls.push({ id, input })
            return this.snapshot()
        },
        async deleteAgent() {
            return this.snapshot()
        },
        async putWorkspaceRoots(values: string[]) {
            workspaceRoots = values
            return this.snapshot()
        },
        async rotateAccessKey() {
            accessKey = 'rotated-test-token'
            return { accessKey }
        }
    } as any
    const server = createAgentdServer(config(), sessions, controlPlane)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    try {
        const redirect = await fetch(base, { redirect: 'manual' })
        assert.equal(redirect.status, 302)
        assert.equal(redirect.headers.get('location'), '/ui/')

        const ui = await fetch(`${base}/ui/`)
        assert.equal(ui.status, 200)
        const uiBody = await ui.text()
        assert.match(uiBody, /NEXUS\/\/CONTROL/)
        assert.match(uiBody, /id="bootstrap-dialog"/)
        assert.match(uiBody, /id="bootstrap-access-key"/)
        assert.match(uiBody, /id="bootstrap-confirm"/)
        assert.match(ui.headers.get('content-security-policy') || '', /nonce-/)
        assert.equal(ui.headers.get('x-frame-options'), 'DENY')

        const unauthorized = await fetch(`${base}/v1/config`)
        assert.equal(unauthorized.status, 401)

        const configuration = await fetch(`${base}/v1/config`, {
            headers: { Authorization: 'Bearer test-token' }
        })
        assert.equal(configuration.status, 200)

        const injection = await fetch(`${base}/v1/config/agents/codex`, {
            method: 'PUT',
            headers: {
                Authorization: 'Bearer test-token',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ driver: 'codex', command: 'sh' })
        })
        assert.equal(injection.status, 400)
        assert.equal(calls.length, 0)

        const saved = await fetch(`${base}/v1/config/agents/codex`, {
            method: 'PUT',
            headers: {
                Authorization: 'Bearer test-token',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                driver: 'codex',
                enabled: true,
                workspace: '/repos'
            })
        })
        assert.equal(saved.status, 200)
        assert.equal(calls.length, 1)
        assert.equal(calls[0].id, 'codex')

        const session = await fetch(`${base}/v1/sessions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer test-token',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ agentId: 'codex' })
        })
        assert.equal(session.status, 201)
        assert.deepEqual(await session.json(), { agentId: 'codex' })

        const roots = await fetch(`${base}/v1/config/workspace-roots`, {
            method: 'PUT',
            headers: {
                Authorization: 'Bearer test-token',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ workspaceRoots: ['/repos', '/work'] })
        })
        assert.equal(roots.status, 200)
        assert.deepEqual(workspaceRoots, ['/repos', '/work'])

        const rotated = await fetch(`${base}/v1/config/access-key/rotate`, {
            method: 'POST',
            headers: { Authorization: 'Bearer test-token' }
        })
        assert.equal(rotated.status, 200)
        assert.deepEqual(await rotated.json(), {
            accessKey: 'rotated-test-token'
        })
        assert.equal(
            (
                await fetch(`${base}/v1/config`, {
                    headers: { Authorization: 'Bearer test-token' }
                })
            ).status,
            401
        )
        assert.equal(
            (
                await fetch(`${base}/v1/config`, {
                    headers: { Authorization: 'Bearer rotated-test-token' }
                })
            ).status,
            200
        )
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

test('first-run setup is single-use and protects the Gateway before initialization', async () => {
    let initialized = false
    let accessKey: string | undefined
    let queue = Promise.resolve()
    const sessions = {
        async listAgents() {
            return []
        }
    } as any
    const controlPlane = {
        isInitialized() {
            return initialized
        },
        accessKey() {
            return accessKey
        },
        initializeAccessKey(value: string, confirmation: string) {
            const result = queue.then(async () => {
                if (initialized) {
                    throw new ControlPlaneError(
                        409,
                        'Gateway setup is already complete'
                    )
                }
                if (value.length < 8) {
                    throw new ControlPlaneError(
                        400,
                        'Access Key must contain at least 8 characters'
                    )
                }
                if (value !== confirmation) {
                    throw new ControlPlaneError(
                        400,
                        'Access Key confirmation does not match'
                    )
                }
                await new Promise<void>((resolve) => setImmediate(resolve))
                initialized = true
                accessKey = value
                return { initialized: true as const }
            })
            queue = result.then(
                () => undefined,
                () => undefined
            )
            return result
        }
    } as any
    const pending = config()
    pending.initialized = false
    pending.authToken = undefined
    const server = createAgentdServer(pending, sessions, controlPlane)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    const setup = (key: string, confirmation = key, headers = {}) =>
        fetch(`${base}/v1/bootstrap/initialize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: base,
                ...headers
            },
            body: JSON.stringify({ accessKey: key, confirmAccessKey: confirmation })
        })
    try {
        assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
            ok: true,
            initialized: false
        })
        assert.deepEqual(
            await (await fetch(`${base}/v1/bootstrap/status`)).json(),
            { initialized: false }
        )
        assert.equal((await fetch(`${base}/v1/agents`)).status, 428)

        const wrongContentType = await fetch(
            `${base}/v1/bootstrap/initialize`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify({
                    accessKey: 'valid-key',
                    confirmAccessKey: 'valid-key'
                })
            }
        )
        assert.equal(wrongContentType.status, 415)
        assert.equal(
            (
                await setup('valid-key', 'valid-key', {
                    Origin: 'http://evil.example'
                })
            ).status,
            403
        )
        assert.equal((await setup('short')).status, 400)
        assert.equal((await setup('valid-key', 'different-key')).status, 400)

        const attempts = await Promise.all([
            setup('first-key'),
            setup('second-key')
        ])
        assert.deepEqual(
            attempts.map((response) => response.status).sort(),
            [201, 409]
        )
        const successful = attempts.find((response) => response.status === 201)
        assert.ok(successful)
        assert.deepEqual(await successful.json(), { initialized: true })
        assert.equal(
            JSON.stringify(await (await fetch(`${base}/v1/bootstrap/status`)).json())
                .includes('key'),
            false
        )
        assert.equal((await setup('third-key')).status, 409)
        assert.equal(
            (
                await fetch(`${base}/v1/agents`, {
                    headers: { Authorization: 'Bearer wrong-key' }
                })
            ).status,
            401
        )
        assert.equal(
            (
                await fetch(`${base}/v1/agents`, {
                    headers: { Authorization: `Bearer ${accessKey}` }
                })
            ).status,
            200
        )
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
    }
})

function config(): AgentdConfig {
    return {
        listen: { host: '127.0.0.1', port: 0 },
        initialized: true,
        authToken: 'test-token',
        workspaceRoots: [],
        maxRequestBytes: 1024 * 1024,
        maxEventsPerSession: 64,
        maxOutputChars: 64 * 1024,
        sessionTtlMs: 60_000,
        agents: {}
    }
}
