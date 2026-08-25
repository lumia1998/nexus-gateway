import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureAgentdConfig, loadAgentdConfig } from '../src/config.js'

test('first run creates a secure pending Gateway config for WebUI setup', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-first-run-'))
    const workspace = path.join(directory, 'repos')
    const configPath = path.join(directory, 'config', 'nexus-agentd.json')
    await mkdir(workspace)
    try {
        const created = await ensureAgentdConfig(configPath, {
            host: '0.0.0.0',
            port: 18888,
            workspace
        })
        assert.deepEqual(created, { created: true })

        const raw = JSON.parse(await readFile(configPath, 'utf8'))
        assert.equal(raw.listen.host, '0.0.0.0')
        assert.equal(raw.listen.port, 18888)
        assert.equal(raw.initialized, false)
        assert.equal('authToken' in raw, false)
        assert.deepEqual(raw.workspaceRoots, [workspace])
        assert.deepEqual(raw.agents, {})

        if (process.platform !== 'win32') {
            assert.equal((await stat(configPath)).mode & 0o777, 0o600)
        }
        const loaded = await loadAgentdConfig(configPath)
        assert.equal(loaded.initialized, false)
        assert.equal(loaded.authToken, undefined)

        const repeated = await ensureAgentdConfig(configPath, {
            workspace: directory
        })
        assert.deepEqual(repeated, { created: false })
        assert.equal(
            JSON.parse(await readFile(configPath, 'utf8')).initialized,
            false
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('legacy configs with an authToken remain initialized', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-legacy-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    try {
        await writeFile(
            configPath,
            JSON.stringify({
                authToken: 'legacy-token',
                workspaceRoots: [directory],
                agents: {}
            })
        )
        const loaded = await loadAgentdConfig(configPath)
        assert.equal(loaded.initialized, true)
        assert.equal(loaded.authToken, 'legacy-token')

        await writeFile(
            configPath,
            JSON.stringify({
                initialized: false,
                authToken: 'ambiguous-token',
                workspaceRoots: [directory],
                agents: {}
            })
        )
        await assert.rejects(
            () => loadAgentdConfig(configPath),
            /pending setup must not contain authToken/
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
