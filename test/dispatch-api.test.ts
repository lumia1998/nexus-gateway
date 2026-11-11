import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { hashAdminPassword } from '../src/auth.js'
import { loadAgentdConfig } from '../src/config.js'
import { AgentdControlPlane } from '../src/control-plane.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import { createAgentdServer } from '../src/server.js'
import { RunStore } from '../src/run-store.js'
import { SessionManager } from '../src/session.js'
import { WorkspacePolicy } from '../src/workspace.js'
import { closeServer } from '../src/index.js'

test('HTTP dispatch, runtime settings, caller decisions, owner-only result and context continuation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-dispatch-http-'))
    const file = path.join(directory, 'config.json')
    const password = randomUUID()
    await writeFile(file, JSON.stringify({ listen: { host: '127.0.0.1', port: 8787 }, workspaceRoots: [directory],
        quotas: { maxSessionsPerKey: 1 },
        adminPasswordHash: await hashAdminPassword(password),
        apiKeys: [
            { id: 'owner', name: 'Owner', secret: 'test-owner-client-key', enabled: true, scope: { allAgents: true, agentIds: [] } },
            { id: 'other', name: 'Other', secret: 'test-other-client-key', enabled: true, scope: { allAgents: true, agentIds: [] } }
        ],
        agents: { kimi: { driver: 'kimi', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/acp-configurable.mjs', import.meta.url))], permissionPolicy: 'ask' } }
    }))
    const config = await loadAgentdConfig(file)
    const store = new RunStore(path.join(directory, 'runs.json')); await store.init()
    const sessions = new SessionManager(config, await WorkspacePolicy.create([directory]), createDriverRegistry(config), store)
    const control = new AgentdControlPlane(file, config, sessions)
    const server = createAgentdServer(config, sessions, control)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    let cookie = ''
    const request = (url: string, method = 'GET', body?: unknown, admin = false, other = false) => fetch(base + url, {
        method, headers: { 'Content-Type': 'application/json', ...(admin ? { Cookie: cookie, Origin: base } : { Authorization: `Bearer ${other ? 'test-other-client-key' : 'test-owner-client-key'}` }) },
        body: body === undefined ? undefined : JSON.stringify(body)
    })
    const waitSession = async (id: string, state = 'completed') => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
            const value = sessions.get(id)
            if (value.state === state) return value
            if (value.state === 'failed') throw new Error(value.error)
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw new Error('Session deadline exceeded')
    }
    try {
        const login = await request('/v1/admin/auth/login', 'POST', { password }, true)
        assert.equal(login.status, 200)
        cookie = login.headers.get('set-cookie')!.split(';')[0]
        const dispatched = await request('/v1/admin/runs', 'POST', { agentId: 'kimi', message: 'permission', options: { permissionPolicy: 'auto', model: 'test/model-b', effort: 'max' } }, true)
        assert.equal(dispatched.status, 202, await dispatched.clone().text())
        const first = await dispatched.json() as any
        await waitSession(first.id)
        const detail = await (await request(`/v1/admin/runs/${first.runId}`, 'GET', undefined, true)).json() as any
        assert.equal(detail.output, 'test/model-b max default')
        assert.ok(detail.events.some((event: any) => event.type === 'permission_decision'))
        assert.equal((await request(`/v1/runs/${first.runId}`)).status, 404)
        const continued = await request(`/v1/admin/runs/${first.runId}/continue`, 'POST', { message: 'follow up' }, true)
        assert.equal(continued.status, 202)
        const follow = await continued.json() as any
        assert.equal(follow.id, first.id)
        assert.notEqual(follow.runId, first.runId)
        await waitSession(follow.id)

        const created = await request('/v1/sessions', 'POST', { agentId: 'kimi' })
        assert.equal(created.status, 201)
        const own = await created.json() as any
        const configured = await request(`/v1/sessions/${own.id}/options`, 'PATCH', { model: 'test/model-b', effort: 'max' })
        assert.equal(configured.status, 200)
        const accepted = await request(`/v1/sessions/${own.id}/message`, 'POST', { message: 'permission' })
        assert.equal(accepted.status, 202)
        const pending = await waitSession(own.id, 'permission_required')
        const decision = await request(`/v1/sessions/${own.id}/requests/${pending.pendingRequest!.id}/resolve`, 'POST', { optionId: 'always' })
        assert.equal(decision.status, 202)
        const done = await waitSession(own.id)
        assert.equal((await request(`/v1/runs/${done.runId}`)).status, 200)
        assert.equal((await request(`/v1/runs/${done.runId}`, 'GET', undefined, false, true)).status, 404)
        assert.equal((await request(`/v1/runs/${done.runId}/resume`, 'POST', {}, false, true)).status, 404)
        await request(`/v1/sessions/${own.id}`, 'DELETE')
        const resumed = await request(`/v1/runs/${done.runId}/resume`, 'POST', {})
        assert.equal(resumed.status, 200)
        assert.equal((await resumed.json() as any).protocolSessionId, own.protocolSessionId)
    } finally {
        await closeServer(server); await sessions.shutdown(); await store.flush()
        await rm(directory, { recursive: true, force: true })
    }
})
