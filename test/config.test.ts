import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureAgentdConfig, loadAgentdConfig } from '../src/config.js'

test('first run creates a pending config and preserves an explicit 0.0.0.0 listener', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-config-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    try {
        const result = await ensureAgentdConfig(configPath, {
            host: '0.0.0.0',
            port: 9876,
            workspace: directory
        })
        assert.deepEqual(result, { created: true })
        const raw = JSON.parse(await readFile(configPath, 'utf8'))
        assert.equal(raw.initialized, false)
        assert.equal(raw.listen.host, '0.0.0.0')
        assert.equal(raw.sessionTtlMs, 24 * 60 * 60 * 1000)
        assert.equal(raw.promptTimeoutMs, 30 * 60 * 1000)
        assert.equal(raw.cleanupIntervalMs, 60_000)
        assert.deepEqual(raw.apiKeys, [])

        const loaded = await loadAgentdConfig(configPath)
        assert.equal(loaded.listen.host, '0.0.0.0')
        assert.equal(loaded.initialized, false)
        assert.equal(loaded.sessionTtlMs, 24 * 60 * 60 * 1000)
        assert.equal(loaded.promptTimeoutMs, 30 * 60 * 1000)
        assert.equal(loaded.cleanupIntervalMs, 60_000)
        assert.deepEqual(loaded.apiKeys, [])
        assert.deepEqual(await ensureAgentdConfig(configPath), { created: false })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('legacy authToken becomes a data-plane key without becoming an admin password', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-legacy-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    try {
        await writeFile(
            configPath,
            JSON.stringify({
                authToken: 'legacy-client-token',
                workspaceRoots: [directory],
                agents: {
                    codex: { driver: 'codex', enabled: false }
                }
            })
        )
        const config = await loadAgentdConfig(configPath)
        assert.equal(config.initialized, true)
        assert.equal(config.adminPasswordHash, undefined)
        assert.equal(config.agents.codex.protocol, 'acp')
        assert.equal(config.apiKeys?.length, 1)
        assert.deepEqual(config.apiKeys?.[0].scope, {
            allAgents: true,
            agentIds: []
        })
        assert.equal(config.apiKeys?.[0].secret, 'legacy-client-token')

        await writeFile(
            configPath,
            JSON.stringify({
                initialized: false,
                authToken: 'must-not-be-here',
                workspaceRoots: [directory],
                agents: {}
            })
        )
        await assert.rejects(() => loadAgentdConfig(configPath), /pending setup.*authToken/)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('config parses ACP and A2A independently and rejects malformed typed fields', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-protocols-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    const secretName = 'AGENT_NEXUS_A2A_TEST_SECRET'
    const previous = process.env[secretName]
    process.env[secretName] = 'remote-secret'
    try {
        const base = {
            initialized: true,
            adminPasswordHash: 'scrypt$placeholder$placeholder',
            workspaceRoots: [directory],
            apiKeys: [],
            agents: {
                local: {
                    protocol: 'acp',
                    driver: 'codex',
                    workspace: directory,
                    instructions: 'Use the user-input mechanism for confirmations.',
                    permissionPolicy: 'allow',
                    args: []
                },
                remote: {
                    protocol: 'a2a',
                    instructions: 'Keep payment tasks pending until verified.',
                    agentCardUrl: 'http://192.168.1.20:8080/custom/card.json',
                    preferredTransport: 'http-json',
                    auth: { type: 'bearer', value: `env:${secretName}` },
                    timeoutMs: 45_000
                }
            }
        }
        await writeFile(configPath, JSON.stringify(base))
        const config = await loadAgentdConfig(configPath)
        assert.equal(config.agents.local.protocol, 'acp')
        assert.equal(
            config.agents.local.instructions,
            'Use the user-input mechanism for confirmations.'
        )
        assert.equal(config.agents.local.permissionPolicy, 'allow')
        assert.equal(config.agents.remote.protocol, 'a2a')
        if (config.agents.remote.protocol === 'a2a') {
            assert.equal(
                config.agents.remote.agentCardUrl,
                'http://192.168.1.20:8080/custom/card.json'
            )
            assert.equal(config.agents.remote.preferredTransport, 'http-json')
            assert.equal(config.agents.remote.auth?.value, 'remote-secret')
            assert.equal(config.agents.remote.timeoutMs, 45_000)
            assert.equal(
                config.agents.remote.instructions,
                'Keep payment tasks pending until verified.'
            )
        }

        await writeFile(
            configPath,
            JSON.stringify({
                ...base,
                agents: { local: { protocol: 'acp', driver: 'codex', instructions: true } }
            })
        )
        await assert.rejects(() => loadAgentdConfig(configPath), /instructions must be a string/)

        await writeFile(configPath, JSON.stringify({ ...base, maxSessions: '64' }))
        await assert.rejects(() => loadAgentdConfig(configPath), /maxSessions must be an integer/)

        await writeFile(
            configPath,
            JSON.stringify({
                ...base,
                agents: { local: { protocol: 'acp', driver: 'codex', args: 'unsafe' } }
            })
        )
        await assert.rejects(() => loadAgentdConfig(configPath), /args must be an array/)

        await writeFile(
            configPath,
            JSON.stringify({
                ...base,
                agents: {
                    remote: {
                        protocol: 'a2a',
                        agentUrl: 'http://192.168.1.20:8080'
                    }
                }
            })
        )
        const legacy = await loadAgentdConfig(configPath)
        if (legacy.agents.remote.protocol === 'a2a') {
            assert.equal(legacy.agents.remote.agentUrl, 'http://192.168.1.20:8080')
            assert.equal(legacy.agents.remote.preferredTransport, 'auto')
        }
    } finally {
        if (previous === undefined) delete process.env[secretName]
        else process.env[secretName] = previous
        await rm(directory, { recursive: true, force: true })
    }
})
