import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadAgentdConfig } from '../src/config.js'
import { AgentdControlPlane } from '../src/control-plane.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import { createAgentdServer } from '../src/server.js'
import { RunStore, runStorePathForConfig } from '../src/run-store.js'
import { SessionManager } from '../src/session.js'
import type { AgentdConfig, AgentdSessionView } from '../src/types.js'
import { WorkspacePolicy } from '../src/workspace.js'

test('Agent Nexus WebUI is embedded, framework-free, and free of the retired control-deck shell', async () => {
    const fixture = await startFreshServer('127.0.0.1')
    try {
        const response = await fetch(`${fixture.base}/ui/`)
        assert.equal(response.status, 200)
        assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/)
        const html = await response.text()
        assert.match(html, /Agent Nexus/)
        assert.match(html, /lang="zh-CN"/)
        for (const label of ['总览', '运行记录', '智能体', '工作区', 'API 密钥', '运行设置']) {
            assert.match(html, new RegExp(`>${label}<`))
        }
        assert.match(html, /Session 空闲有效期（小时）/)
        assert.match(html, /清理任务周期（秒）/)
        const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
        assert.ok(script)
        assert.doesNotThrow(() => new Function(script))
        assert.match(html, /检查中/)
        assert.doesNotMatch(html, /尚未检查/)
        assert.match(html, /Agent Card URL/)
        assert.match(html, /首选传输/)
        assert.match(html, /Bearer Token/)
        assert.doesNotMatch(html, /gradient|backdrop-filter|sessionStorage|nexus-agentd-token/i)
        assert.doesNotMatch(html, /react|vue|unpkg|jsdelivr/i)
        assert.equal((await fetch(`${fixture.base}/`)).url, `${fixture.base}/ui/`)
    } finally {
        await fixture.close()
    }
})

test('Console Cookie and client API Keys are separate, with upgrade-safe bootstrap and password revocation', async () => {
    const fixture = await startFreshServer('0.0.0.0')
    try {
        assert.equal((fixture.server.address() as AddressInfo).address, '0.0.0.0')
        assert.deepEqual(await json(`${fixture.base}/health`), {
            ok: true,
            initialized: false,
            adminSetupRequired: true
        })
        assert.equal((await fetch(`${fixture.base}/v1/agents`)).status, 428)

        assert.equal(
            (
                await fetch(`${fixture.base}/v1/bootstrap/initialize`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        password: 'initial-password',
                        confirmPassword: 'initial-password'
                    })
                })
            ).status,
            403
        )
        assert.equal(
            (
                await fetch(`${fixture.base}/v1/bootstrap/initialize`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Origin: 'http://evil.example'
                    },
                    body: JSON.stringify({
                        password: 'initial-password',
                        confirmPassword: 'initial-password'
                    })
                })
            ).status,
            403
        )
        const initialized = await fetch(`${fixture.base}/v1/bootstrap/initialize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: fixture.base },
            body: JSON.stringify({
                password: 'initial-password',
                confirmPassword: 'initial-password'
            })
        })
        assert.equal(initialized.status, 201)
        assert.equal((await fixture.control.listApiKeys()).length, 0)

        assert.equal((await login(fixture.base, 'wrong-password')).status, 401)
        const signedIn = await login(fixture.base, 'initial-password')
        assert.equal(signedIn.status, 200)
        const cookie = signedIn.headers.get('set-cookie') || ''
        assert.match(cookie, /^agent_nexus_admin=/)
        assert.match(cookie, /HttpOnly/i)
        assert.match(cookie, /SameSite=Strict/i)
        assert.doesNotMatch(cookie, /Secure/i)

        assert.equal(
            (
                await fetch(`${fixture.base}/v1/admin/config`, {
                    headers: { Authorization: 'Bearer initial-password' }
                })
            ).status,
            401
        )
        const initialConfig = await adminGet(fixture.base, '/v1/admin/config', cookie)
        assert.equal(initialConfig.status, 200)
        const initialRuntime = await initialConfig.json()
        assert.equal(initialRuntime.sessionTtlMs, 24 * 60 * 60 * 1000)
        assert.equal(initialRuntime.promptTimeoutMs, 30 * 60 * 1000)
        assert.equal(initialRuntime.cleanupIntervalMs, 60_000)
        const runtimeResponse = await adminJson(
            fixture.base,
            '/v1/admin/config/runtime',
            cookie,
            'PUT',
            {
                sessionTtlMs: 48 * 60 * 60 * 1000,
                promptTimeoutMs: 20 * 60 * 1000,
                cleanupIntervalMs: 30_000
            }
        )
        assert.equal(runtimeResponse.status, 200)
        assert.deepEqual(
            ((await runtimeResponse.json()) as Record<string, unknown>),
            {
                workspaceRoots: [fixture.directory],
                driverKinds: ['opencode', 'claude', 'codex', 'pi', 'openclaw', 'hermes'],
                sessionTtlMs: 48 * 60 * 60 * 1000,
                promptTimeoutMs: 20 * 60 * 1000,
                cleanupIntervalMs: 30_000,
                agents: []
            }
        )
        assert.equal(
            (
                await fetch(`${fixture.base}/v1/agents`, {
                    headers: { Cookie: cookie }
                })
            ).status,
            401
        )

        const keyResponse = await adminJson(
            fixture.base,
            '/v1/admin/api-keys',
            cookie,
            'POST',
            {
                name: 'LAN client',
                scope: { allAgents: true, agentIds: [] }
            }
        )
        assert.equal(keyResponse.status, 201)
        const created = await keyResponse.json()
        assert.match(created.secret, /^nx_sk_/)
        const listed = await (await adminGet(fixture.base, '/v1/admin/api-keys', cookie)).json()
        assert.equal(JSON.stringify(listed).includes(created.secret), false)
        assert.equal(
            (
                await fetch(`${fixture.base}/v1/agents`, {
                    headers: { Authorization: `Bearer ${created.secret}` }
                })
            ).status,
            200
        )

        const reveal = await adminJson(
            fixture.base,
            `/v1/admin/api-keys/${created.key.id}/reveal`,
            cookie,
            'POST'
        )
        assert.equal((await reveal.json()).secret, created.secret)

        const changed = await adminJson(
            fixture.base,
            '/v1/admin/password',
            cookie,
            'PUT',
            {
                currentPassword: 'initial-password',
                newPassword: 'replacement-password',
                confirmPassword: 'replacement-password'
            }
        )
        assert.equal(changed.status, 200)
        assert.match(changed.headers.get('set-cookie') || '', /Max-Age=0/)
        assert.equal((await adminGet(fixture.base, '/v1/admin/config', cookie)).status, 401)
        assert.equal((await login(fixture.base, 'initial-password')).status, 401)
        assert.equal((await login(fixture.base, 'replacement-password')).status, 200)
    } finally {
        await fixture.close()
    }
})

test('run history is admin-only, filterable, and exposes bounded details', async () => {
    const fixture = await startFreshServer('127.0.0.1')
    try {
        const initialized = await fetch(`${fixture.base}/v1/bootstrap/initialize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: fixture.base },
            body: JSON.stringify({
                password: 'runs-password',
                confirmPassword: 'runs-password'
            })
        })
        assert.equal(initialized.status, 201)
        const signedIn = await login(fixture.base, 'runs-password')
        const cookie = signedIn.headers.get('set-cookie') || ''

        const hermes = fixture.runStore.create({
            sessionId: 'session-hermes',
            agentId: 'hermes',
            agentName: 'Hermes Agent',
            protocol: 'acp',
            ownerKeyId: 'private-key-id',
            task: '  原样保留的任务  '
        })
        fixture.runStore.update(hermes.id, {
            state: 'completed',
            progress: { phase: '已完成' },
            output: '任务结果',
            endedAt: Date.now()
        })
        fixture.runStore.create({
            sessionId: 'session-claude',
            agentId: 'claude',
            agentName: 'Claude Code',
            protocol: 'acp',
            ownerKeyId: 'another-key-id',
            task: '修复项目'
        })

        assert.equal((await fetch(`${fixture.base}/v1/admin/runs`)).status, 401)
        assert.equal(
            (
                await fetch(`${fixture.base}/v1/admin/runs`, {
                    headers: { Authorization: 'Bearer private-key-id' }
                })
            ).status,
            401
        )

        const listed = await adminGet(
            fixture.base,
            '/v1/admin/runs?agentId=hermes&state=completed&limit=10',
            cookie
        )
        assert.equal(listed.status, 200)
        const body = await listed.json()
        assert.equal(body.total, 1)
        assert.equal(body.runs[0].id, hermes.id)
        assert.equal(body.runs[0].task, '  原样保留的任务  ')
        assert.equal(body.runs[0].resultSummary, '任务结果')
        assert.equal('output' in body.runs[0], false)
        assert.equal(JSON.stringify(body).includes('private-key-id'), false)

        const detailResponse = await adminGet(
            fixture.base,
            `/v1/admin/runs/${hermes.id}`,
            cookie
        )
        assert.equal(detailResponse.status, 200)
        const detail = await detailResponse.json()
        assert.equal(detail.output, '任务结果')
        assert.equal(detail.progress.phase, '已完成')
        assert.equal(JSON.stringify(detail).includes('private-key-id'), false)
        assert.equal(
            (
                await adminGet(
                    fixture.base,
                    '/v1/admin/runs/does-not-exist',
                    cookie
                )
            ).status,
            404
        )
    } finally {
        await fixture.close()
    }
})

test('API Key Agent scope and session ownership are enforced independently', async () => {
    const sessions = new FakeSessions()
    const config = configuredServerConfig()
    const server = createAgentdServer(config, sessions as any)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
        const inventory = await fetch(`${base}/v1/agents`, {
            headers: { Authorization: 'Bearer key-a-secret-value' }
        })
        assert.deepEqual(
            (await inventory.json()).agents.map((agent: { id: string }) => agent.id),
            ['agent-a']
        )
        assert.equal(
            (
                await fetch(`${base}/v1/sessions`, {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer key-a-secret-value',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ agentId: 'agent-b' })
                })
            ).status,
            403
        )
        const createdResponse = await fetch(`${base}/v1/sessions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer key-a-secret-value',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ agentId: 'agent-a' })
        })
        assert.equal(createdResponse.status, 201)
        const created = await createdResponse.json()
        const attachmentResponse = await fetch(
            `${base}/v1/sessions/${created.id}/attachments`,
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer key-a-secret-value',
                    'Content-Type': 'text/plain',
                    'X-Nexus-File-Name': encodeURIComponent('需求说明.txt')
                },
                body: new TextEncoder().encode('请保留原始文件内容')
            }
        )
        assert.equal(attachmentResponse.status, 201)
        assert.deepEqual(await attachmentResponse.json(), {
            id: 'attachment-1',
            name: '需求说明.txt',
            mediaType: 'text/plain',
            size: new TextEncoder().encode('请保留原始文件内容').length
        })
        assert.equal(
            (
                await fetch(`${base}/v1/sessions/${created.id}/attachments`, {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer key-b-secret-value',
                        'Content-Type': 'text/plain'
                    },
                    body: 'no'
                })
            ).status,
            404
        )
        assert.equal(
            (
                await fetch(`${base}/v1/sessions/${created.id}`, {
                    headers: { Authorization: 'Bearer key-b-secret-value' }
                })
            ).status,
            404
        )
        assert.equal(
            (
                await fetch(`${base}/v1/sessions/${created.id}`, {
                    headers: { Authorization: 'Bearer key-a-secret-value' }
                })
            ).status,
            200
        )

        sessions.failInventory = true
        const hidden = await fetch(`${base}/v1/agents`, {
            headers: { Authorization: 'Bearer key-a-secret-value' }
        })
        assert.equal(hidden.status, 500)
        const failure = await hidden.json()
        assert.equal(failure.error, 'Internal server error')
        assert.equal(typeof failure.requestId, 'string')
    } finally {
        await closeServer(server)
    }
})

async function startFreshServer(host: string) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-server-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    await writeFile(
        configPath,
        JSON.stringify({
            initialized: false,
            listen: { host, port: 8787 },
            workspaceRoots: [directory],
            apiKeys: [],
            agents: {}
        })
    )
    const config = await loadAgentdConfig(configPath)
    const runStore = new RunStore(runStorePathForConfig(configPath), 20)
    await runStore.init()
    const sessions = new SessionManager(
        config,
        await WorkspacePolicy.create(config.workspaceRoots),
        createDriverRegistry(config),
        runStore
    )
    const control = new AgentdControlPlane(configPath, config, sessions)
    const server = createAgentdServer(config, sessions, control)
    await new Promise<void>((resolve) => server.listen(0, host, resolve))
    const port = (server.address() as AddressInfo).port
    return {
        directory,
        configPath,
        sessions,
        runStore,
        control,
        server,
        base: `http://127.0.0.1:${port}`,
        async close() {
            await closeServer(server)
            await sessions.shutdown()
            await runStore.flush()
            await rm(directory, { recursive: true, force: true })
        }
    }
}

function configuredServerConfig(): AgentdConfig {
    return {
        listen: { host: '127.0.0.1', port: 0 },
        initialized: true,
        adminPasswordHash: 'not-used-by-this-test',
        apiKeys: [
            {
                id: 'key-a',
                name: 'A',
                secret: 'key-a-secret-value',
                enabled: true,
                scope: { allAgents: false, agentIds: ['agent-a'] },
                createdAt: 1
            },
            {
                id: 'key-b',
                name: 'B',
                secret: 'key-b-secret-value',
                enabled: true,
                scope: { allAgents: true, agentIds: [] },
                createdAt: 2
            }
        ],
        workspaceRoots: [],
    maxRequestBytes: 1024 * 1024,
        maxAttachmentBytes: 32 * 1024 * 1024,
        maxEventsPerSession: 64,
        maxOutputChars: 64 * 1024,
        sessionTtlMs: 60_000,
        agents: {
            'agent-a': { protocol: 'acp', driver: 'codex' },
            'agent-b': { protocol: 'acp', driver: 'codex' }
        }
    }
}

class FakeSessions {
    failInventory = false
    private readonly sessions = new Map<string, AgentdSessionView & { ownerKeyId: string }>()

    async listAgents(ids?: Set<string>) {
        if (this.failInventory) throw new Error('sensitive inventory failure')
        return ['agent-a', 'agent-b']
            .filter((id) => !ids || ids.has(id))
            .map((id) => ({
                id,
                name: id,
                protocol: 'acp' as const,
                ready: true,
                enabled: true
            }))
    }

    async create(agentId: string, _workspace: string | undefined, ownerKeyId: string) {
        const now = Date.now()
        const session = {
            id: `session-${this.sessions.size + 1}`,
            protocol: 'acp' as const,
            agentId,
            state: 'created' as const,
            artifacts: [],
            createdAt: now,
            updatedAt: now,
            ownerKeyId
        }
        this.sessions.set(session.id, session)
        return session
    }

    get(id: string) {
        const session = this.sessions.get(id)
        if (!session) throw new Error('not found')
        const { ownerKeyId: _owner, ...view } = session
        return view
    }

    owns(id: string, keyId: string) {
        return this.sessions.get(id)?.ownerKeyId === keyId
    }

    count() {
        return this.sessions.size
    }

    addInputAttachment(
        id: string,
        name: string,
        mediaType: string | undefined,
        bytes: Buffer
    ) {
        if (!this.sessions.has(id)) throw new Error('not found')
        return {
            id: 'attachment-1',
            name,
            mediaType,
            size: bytes.length
        }
    }
}

function login(base: string, password: string) {
    return fetch(`${base}/v1/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ password })
    })
}

function adminGet(base: string, pathname: string, cookie: string) {
    return fetch(`${base}${pathname}`, { headers: { Cookie: cookie } })
}

function adminJson(
    base: string,
    pathname: string,
    cookie: string,
    method: string,
    body?: unknown
) {
    return fetch(`${base}${pathname}`, {
        method,
        headers: {
            Cookie: cookie,
            Origin: base,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
}

async function json(url: string) {
    return (await fetch(url)).json()
}

function closeServer(server: ReturnType<typeof createAgentdServer>) {
    return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeIdleConnections?.()
    })
}
