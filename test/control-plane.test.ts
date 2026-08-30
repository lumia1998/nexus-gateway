import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadAgentdConfig } from '../src/config.js'
import { AgentdControlPlane, ControlPlaneError } from '../src/control-plane.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import { SessionManager } from '../src/session.js'
import { WorkspacePolicy } from '../src/workspace.js'

test('Console Password setup is hashed, atomic, separate from API Keys, and one-time', async () => {
    const fixture = await createFixture({ initialized: false, apiKeys: [], agents: {} })
    try {
        assert.equal(fixture.control.needsAdminSetup(), true)
        await assert.rejects(
            () => fixture.control.initializeAdminPassword('too-short', 'too-short'),
            /at least 12 characters/
        )
        await assert.rejects(
            () => fixture.control.initializeAdminPassword('first-password', 'other-password'),
            /confirmation does not match/
        )

        const attempts = await Promise.allSettled([
            fixture.control.initializeAdminPassword('first-password', 'first-password'),
            fixture.control.initializeAdminPassword('second-password', 'second-password')
        ])
        assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1)
        const rejected = attempts.find(
            (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'
        )
        assert.ok(rejected?.reason instanceof ControlPlaneError)
        assert.equal(rejected.reason.status, 409)

        const raw = JSON.parse(await readFile(fixture.configPath, 'utf8'))
        assert.match(raw.adminPasswordHash, /^scrypt\$/)
        assert.equal(JSON.stringify(raw).includes('first-password'), false)
        assert.equal(JSON.stringify(raw).includes('second-password'), false)
        assert.deepEqual(raw.apiKeys, [])
        assert.equal(await fixture.control.verifyAdminPassword('first-password'), true)
        assert.equal(await fixture.control.verifyAdminPassword('second-password'), false)
    } finally {
        await fixture.close()
    }
})

test('control plane manages ACP/A2A agents and recoverable scoped API Keys without leaking secrets', async () => {
    const fixture = await createFixture({
        initialized: true,
        authToken: 'legacy-token-value',
        workspaceRoots: [],
        agents: {}
    })
    const project = path.join(fixture.directory, 'project')
    await mkdir(project)
    try {
        const legacy = fixture.control.listApiKeys()
        assert.equal(legacy.length, 1)
        assert.equal(legacy[0].legacy, true)
        assert.ok(fixture.control.authenticateApiKey('legacy-token-value'))
        assert.equal(JSON.stringify(fixture.control.snapshot()).includes('legacy-token-value'), false)

        const runtime = await fixture.control.putRuntimeSettings({
            sessionTtlMs: 48 * 60 * 60 * 1000,
            promptTimeoutMs: 20 * 60 * 1000,
            cleanupIntervalMs: 30_000
        })
        assert.equal(runtime.sessionTtlMs, 48 * 60 * 60 * 1000)
        assert.equal(runtime.promptTimeoutMs, 20 * 60 * 1000)
        assert.equal(runtime.cleanupIntervalMs, 30_000)
        const runtimeRaw = JSON.parse(await readFile(fixture.configPath, 'utf8'))
        assert.equal(runtimeRaw.sessionTtlMs, 48 * 60 * 60 * 1000)
        assert.equal(runtimeRaw.promptTimeoutMs, 20 * 60 * 1000)
        assert.equal(runtimeRaw.cleanupIntervalMs, 30_000)
        await assert.rejects(
            () => fixture.control.putRuntimeSettings({
                sessionTtlMs: 60_000,
                promptTimeoutMs: 20 * 60 * 1000,
                cleanupIntervalMs: 1_000
            }),
            (error: unknown) => error instanceof ControlPlaneError && error.status === 400
        )

        await fixture.control.putAgent('local', {
            protocol: 'acp',
            driver: 'codex',
            name: 'Local Codex',
            enabled: false,
            workspace: project,
            permissionPolicy: 'deny',
            permissionTimeoutMs: 30_000
        })
        await fixture.control.putAgent('remote', {
            protocol: 'a2a',
            name: 'Remote Research',
            agentCardUrl: 'http://192.168.1.20:8080/custom/agent-card.json',
            preferredTransport: 'http-json',
            authType: 'header',
            authHeaderName: 'X-API-Key',
            authValue: 'remote-agent-secret',
            timeoutMs: 45_000
        })
        const snapshot = fixture.control.snapshot()
        assert.equal(snapshot.agents.find((agent) => agent.id === 'local')?.driver, 'codex')
        assert.equal(
            snapshot.agents.find((agent) => agent.id === 'local')?.permissionPolicy,
            'deny'
        )
        await fixture.control.putAgent('local', { permissionPolicy: 'allow' })
        assert.equal(
            fixture.control.snapshot().agents.find((agent) => agent.id === 'local')
                ?.permissionPolicy,
            'allow'
        )
        const remote = snapshot.agents.find((agent) => agent.id === 'remote')
        assert.equal(remote?.protocol, 'a2a')
        assert.equal(
            remote?.agentCardUrl,
            'http://192.168.1.20:8080/custom/agent-card.json'
        )
        assert.equal(remote?.preferredTransport, 'http-json')
        assert.equal(remote?.auth?.configured, true)
        assert.equal(JSON.stringify(snapshot).includes('remote-agent-secret'), false)

        await fixture.control.putAgent('legacy-remote', {
            protocol: 'a2a',
            name: 'Legacy Remote',
            agentUrl: 'http://192.168.1.21:8080'
        })
        await fixture.control.putAgent('legacy-remote', {
            protocol: 'a2a',
            name: 'Renamed Legacy Remote'
        })
        const legacyRemote = fixture.control
            .snapshot()
            .agents.find((agent) => agent.id === 'legacy-remote')
        assert.equal(
            legacyRemote?.agentCardUrl,
            'http://192.168.1.21:8080/.well-known/agent-card.json'
        )

        const created = await fixture.control.createApiKey(
            'Scoped client',
            { allAgents: false, agentIds: ['remote'] },
            'custom-client-key-1234'
        )
        assert.equal(created.secret, 'custom-client-key-1234')
        assert.deepEqual(created.key.scope.agentIds, ['remote'])
        assert.equal(
            fixture.control.authenticateApiKey('custom-client-key-1234')?.id,
            created.key.id
        )
        assert.equal(
            fixture.control.revealApiKey(created.key.id).secret,
            'custom-client-key-1234'
        )

        const renamed = await fixture.control.updateApiKey(created.key.id, {
            name: 'Renamed client',
            enabled: false,
            scope: { allAgents: true, agentIds: ['remote'] }
        })
        assert.equal(renamed.name, 'Renamed client')
        assert.deepEqual(renamed.scope, { allAgents: true, agentIds: [] })
        assert.equal(fixture.control.authenticateApiKey('custom-client-key-1234'), undefined)

        const regenerated = await fixture.control.regenerateApiKey(created.key.id)
        assert.match(regenerated.secret, /^nx_sk_[A-Za-z0-9_-]{30,}$/)
        assert.equal(regenerated.key.enabled, false)
        await fixture.control.deleteApiKey(created.key.id)
        assert.equal(fixture.control.listApiKeys().some((key) => key.id === created.key.id), false)

        const persisted = JSON.parse(await readFile(fixture.configPath, 'utf8'))
        assert.equal(persisted.authToken, 'legacy-token-value')
        assert.equal(persisted.agents.remote.auth.value, 'remote-agent-secret')
        assert.equal(
            persisted.agents.remote.agentCardUrl,
            'http://192.168.1.20:8080/custom/agent-card.json'
        )
        assert.equal(persisted.agents.remote.agentUrl, undefined)
        assert.equal(persisted.agents.local.command, undefined)
    } finally {
        await fixture.close()
    }
})

async function createFixture(input: Record<string, unknown>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-control-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    const raw = {
        workspaceRoots: [directory],
        ...input
    }
    if (Array.isArray(raw.workspaceRoots) && !raw.workspaceRoots.length) {
        raw.workspaceRoots = [directory]
    }
    await writeFile(configPath, JSON.stringify(raw))
    const config = await loadAgentdConfig(configPath)
    const policy = await WorkspacePolicy.create(config.workspaceRoots)
    const sessions = new SessionManager(config, policy, createDriverRegistry(config))
    const control = new AgentdControlPlane(configPath, config, sessions)
    return {
        directory,
        configPath,
        sessions,
        control,
        async close() {
            await sessions.shutdown()
            await rm(directory, { recursive: true, force: true })
        }
    }
}
