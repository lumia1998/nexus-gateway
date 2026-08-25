import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadAgentdConfig } from '../src/config.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import type { AgentdConfig, AgentdDriverConfig } from '../src/types.js'

test('registers every supported ACP driver with stable defaults', () => {
    const drivers = createDriverRegistry(
        config({
            opencode: { driver: 'opencode' },
            claude: { driver: 'claude' },
            codex: { driver: 'codex' },
            pi: { driver: 'pi' },
            openclaw: { driver: 'openclaw' },
            hermes: { driver: 'hermes' },
            disabled: { driver: 'codex', enabled: false }
        })
    )

    assert.equal(drivers.size, 6)
    assert.deepEqual(driverCommand(drivers, 'opencode'), ['opencode', ['acp']])
    assert.deepEqual(driverCommand(drivers, 'claude'), ['claude-agent-acp', []])
    assert.deepEqual(driverCommand(drivers, 'codex'), ['codex-acp', []])
    assert.deepEqual(driverCommand(drivers, 'pi'), ['pi-acp', []])
    assert.deepEqual(driverCommand(drivers, 'openclaw'), ['openclaw', ['acp']])
    assert.deepEqual(driverCommand(drivers, 'hermes'), ['hermes', ['acp']])
    assert.equal(drivers.get('openclaw')?.env.OPENCLAW_HIDE_BANNER, '1')
    assert.equal(drivers.has('disabled'), false)
})

test('probes configured ACP commands without depending on installed agents', async () => {
    const node = process.execPath
    const probeConfig = (driver: AgentdDriverConfig['driver']): AgentdDriverConfig => ({
        driver,
        command: node,
        args: [],
        env: driver === 'pi' ? { PI_ACP_PI_COMMAND: node } : undefined
    })
    const drivers = createDriverRegistry(
        config({
            opencode: probeConfig('opencode'),
            claude: probeConfig('claude'),
            codex: probeConfig('codex'),
            pi: probeConfig('pi'),
            openclaw: probeConfig('openclaw')
        })
    )

    const results = await Promise.all(
        Array.from(drivers.values()).map((driver) => driver.probe())
    )
    assert.equal(results.every((result) => result.ready), true)
    assert.equal(results.every((result) => Boolean(result.version)), true)
})

test('loads every supported ACP driver kind and rejects unknown drivers', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-drivers-'))
    const file = path.join(directory, 'nexus-agentd.json')
    try {
        await writeFile(
            file,
            JSON.stringify({
                authToken: 'test-token',
                workspaceRoots: [directory],
                agents: {
                    opencode: {},
                    claude: {},
                    codex: {},
                    pi: {},
                    openclaw: {},
                    hermes: {}
                }
            })
        )
        const loaded = await loadAgentdConfig(file)
        assert.deepEqual(
            Object.values(loaded.agents).map((agent) => agent.driver),
            ['opencode', 'claude', 'codex', 'pi', 'openclaw', 'hermes']
        )

        await writeFile(
            file,
            JSON.stringify({
                authToken: 'test-token',
                workspaceRoots: [directory],
                agents: { unknown: { driver: 'unknown' } }
            })
        )
        await assert.rejects(() => loadAgentdConfig(file), /Unsupported.*unknown/)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

function config(agents: Record<string, AgentdDriverConfig>): AgentdConfig {
    return {
        listen: { host: '127.0.0.1', port: 0 },
        initialized: true,
        authToken: 'test-token',
        workspaceRoots: [],
        maxRequestBytes: 1024 * 1024,
        maxEventsPerSession: 64,
        maxOutputChars: 64 * 1024,
        sessionTtlMs: 60_000,
        agents
    }
}

function driverCommand(
    drivers: ReturnType<typeof createDriverRegistry>,
    id: string
) {
    const driver = drivers.get(id)
    assert.ok(driver)
    return [driver.command, driver.args]
}
