import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadAgentdConfig } from '../src/config.js'
import { createDriverRegistry } from '../src/drivers/index.js'
import { createStdioAcpDriver, probeCommand } from '../src/drivers/stdio.js'
import { AcpProcessRuntime } from '../src/acp/runtime.js'
import { ManagedSession } from '../src/session.js'
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

test('probe timeout tears down a real child process tree on the current platform', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-probe-tree-'))
    const marker = path.join(directory, 'child.pid')
    const fixture = path.join(process.cwd(), 'test', 'fixtures', 'probe-tree.mjs')
    try {
        await assert.rejects(
            () => probeCommand(process.execPath, [fixture, marker], {}, 'tree', {
                timeoutMs: 250,
                ownsProcessGroup: process.platform !== 'win32'
            }),
            /probe timed out/
        )
        const childPid = Number(await waitForFile(marker))
        await waitForProcessGone(childPid)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('successful POSIX probes clean descendants after the leader exits', {
    skip: process.platform === 'win32' ? 'Windows cannot address descendants after the leader exits' : false
}, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-probe-exit-'))
    const marker = path.join(directory, 'child.pid')
    const fixture = path.join(process.cwd(), 'test', 'fixtures', 'probe-tree-exit.mjs')
    try {
        await probeCommand(process.execPath, [fixture, marker], {}, 'tree', {
            timeoutMs: 1000,
            ownsProcessGroup: true
        })
        const childPid = Number(await waitForFile(marker))
        await waitForProcessGone(childPid)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('custom stdio driver preserves a configured command, args and environment', () => {
    const driver = createStdioAcpDriver('custom', {
        driver: 'stdio',
        command: process.execPath,
        args: ['--version'],
        probeArgs: ['--help'],
        env: { NEXUS_TEST_DRIVER: 'present' }
    }, {
        name: 'Custom',
        description: 'Custom stdio test driver',
        command: process.execPath,
        args: []
    })
    assert.deepEqual([driver.command, driver.args], [process.execPath, ['--version']])
    assert.equal(driver.env.NEXUS_TEST_DRIVER, 'present')
})

test('stdio ACP launches a command wrapper from a path containing spaces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-stdio-space-'))
    const wrapperDirectory = path.join(directory, 'agent wrapper with spaces')
    await mkdir(wrapperDirectory)
    const wrapper = path.join(
        wrapperDirectory,
        process.platform === 'win32' ? 'agent.cmd' : 'agent.sh'
    )
    const fixture = path.join(process.cwd(), 'test', 'fixtures', 'acp-handshake.mjs')
    const script = process.platform === 'win32'
        ? `@echo off\r\n"%NEXUS_NODE%" "${fixture}" %*\r\n`
        : `#!/bin/sh\nexec "$NEXUS_NODE" "${fixture}" "$@"\n`
    await writeFile(wrapper, script)
    if (process.platform !== 'win32') await chmod(wrapper, 0o755)
    const driver = createStdioAcpDriver('wrapper', {
        driver: 'stdio',
        command: wrapper,
        args: ['ready'],
        env: { NEXUS_NODE: process.execPath }
    }, {
        name: 'Wrapper',
        description: 'Wrapper test driver',
        command: wrapper,
        args: ['ready']
    })
    const state = new ManagedSession('wrapper', 'acp', directory, 'owner', 64, 64 * 1024, 'Wrapper')
    const runtime = new AcpProcessRuntime(driver, state, 1024, 10_000, [directory], 2_000)
    try {
        await runtime.start(directory)
        assert.equal(state.acpSessionId, 'test-session')
        await runtime.cancel()
        assert.equal(state.state, 'canceled')
        assert.equal(runtime.isAvailable(), false)
    } finally {
        await runtime.dispose()
        await rm(directory, { recursive: true, force: true })
    }
})

test('stdio ACP resolves a bare shim from a PATH directory containing spaces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-stdio-bare-'))
    const shimDirectory = path.join(directory, 'agent shim directory with spaces')
    await mkdir(shimDirectory)
    const shim = path.join(
        shimDirectory,
        process.platform === 'win32' ? 'nexus-bare-shim.cmd' : 'nexus-bare-shim'
    )
    const fixture = path.join(process.cwd(), 'test', 'fixtures', 'acp-handshake.mjs')
    const script = process.platform === 'win32'
        ? `@echo off\r\n"%NEXUS_NODE%" "${fixture}" %*\r\n`
        : `#!/bin/sh\nexec "$NEXUS_NODE" "${fixture}" "$@"\n`
    await writeFile(shim, script)
    if (process.platform === 'win32') {
        // npm ships both sh and cmd wrappers; the extensionless sh file must
        // not shadow the .cmd wrapper during Windows command resolution.
        await writeFile(path.join(shimDirectory, 'nexus-bare-shim'), '#!/bin/sh\nexit 77\n')
    }
    if (process.platform !== 'win32') await chmod(shim, 0o755)
    const childPath = [shimDirectory, process.env.PATH].filter(Boolean).join(path.delimiter)
    const driver = createStdioAcpDriver('bare-wrapper', {
        driver: 'stdio',
        command: 'nexus-bare-shim',
        args: ['ready'],
        env: { NEXUS_NODE: process.execPath, PATH: childPath }
    }, {
        name: 'Bare wrapper',
        description: 'Bare shim test driver',
        command: 'nexus-bare-shim',
        args: ['ready']
    })
    const state = new ManagedSession('bare-wrapper', 'acp', directory, 'owner', 64, 64 * 1024, 'Bare wrapper')
    const runtime = new AcpProcessRuntime(driver, state, 1024, 10_000, [directory], 2_000)
    try {
        const probe = await driver.probe()
        assert.equal(probe.ready, true)
        await runtime.start(directory)
        assert.equal(state.acpSessionId, 'test-session')
        await runtime.cancel()
        assert.equal(state.state, 'canceled')
        assert.equal(runtime.isAvailable(), false)
    } finally {
        await runtime.dispose()
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

async function waitForFile(file: string) {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
        try { return (await readFile(file, 'utf8')).trim() } catch {}
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Timed out waiting for ${file}`)
}

async function waitForProcessGone(pid: number) {
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0)
        } catch {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`Process ${pid} is still alive`)
}
