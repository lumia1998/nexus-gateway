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

test('control plane persists safe agent settings and reloads the live registry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-control-'))
    const workspaceRoot = path.join(directory, 'repos')
    const project = path.join(workspaceRoot, 'project')
    const outside = path.join(directory, 'outside')
    const configPath = path.join(directory, 'nexus-agentd.json')
    const secretName = 'NEXUS_AGENTD_CONTROL_PLANE_TEST_TOKEN'
    const previousSecret = process.env[secretName]
    process.env[secretName] = 'test-token'
    await mkdir(project, { recursive: true })
    await mkdir(outside)
    await writeFile(
        configPath,
        JSON.stringify({
            authToken: `env:${secretName}`,
            workspaceRoots: [workspaceRoot],
            agents: {
                codex: {
                    driver: 'codex',
                    enabled: false,
                    command: process.execPath,
                    args: [],
                    env: { PRESERVE_ME: 'yes' }
                }
            }
        })
    )

    try {
        const config = await loadAgentdConfig(configPath)
        const sessions = new SessionManager(
            config,
            await WorkspacePolicy.create(config.workspaceRoots),
            createDriverRegistry(config)
        )
        const control = new AgentdControlPlane(configPath, config, sessions)

        const preserved = await control.putAgent('codex', {
            driver: 'codex',
            workspace: project
        })
        assert.equal(preserved.agents[0].enabled, false)
        assert.equal(
            JSON.parse(await readFile(configPath, 'utf8')).agents.codex.enabled,
            false
        )

        const updated = await control.putAgent('codex', {
            driver: 'codex',
            name: 'Code Review',
            description: 'Reviews the selected repository',
            enabled: true,
            workspace: project,
            permissionPolicy: 'deny',
            permissionTimeoutMs: 30_000
        })
        assert.equal(updated.agents[0].name, 'Code Review')
        assert.equal(updated.agents[0].workspace, project)

        const inventory = await sessions.listAgents()
        assert.equal(inventory.length, 1)
        assert.equal(inventory[0].id, 'codex')
        assert.equal(inventory[0].workspace, project)
        assert.equal(inventory[0].enabled, true)

        const persisted = JSON.parse(await readFile(configPath, 'utf8'))
        assert.equal(persisted.authToken, `env:${secretName}`)
        assert.equal(persisted.agents.codex.command, process.execPath)
        assert.deepEqual(persisted.agents.codex.env, { PRESERVE_ME: 'yes' })

        await assert.rejects(
            () =>
                control.putAgent('codex', {
                    driver: 'codex',
                    enabled: true,
                    workspace: outside
                }),
            /outside the configured allowlist/
        )
        assert.equal(
            JSON.parse(await readFile(configPath, 'utf8')).agents.codex.workspace,
            project
        )

        const roots = await control.putWorkspaceRoots([workspaceRoot, outside])
        assert.deepEqual(roots.workspaceRoots, [workspaceRoot, outside])

        const rotated = await control.rotateAccessKey()
        assert.match(rotated.accessKey, /^[A-Za-z0-9_-]{40,}$/)
        assert.equal(control.accessKey(), rotated.accessKey)
        assert.equal(
            JSON.parse(await readFile(configPath, 'utf8')).authToken,
            rotated.accessKey
        )

        const removed = await control.deleteAgent('codex')
        assert.deepEqual(removed.agents, [])
        assert.deepEqual(await sessions.listAgents(), [])
    } finally {
        if (previousSecret === undefined) delete process.env[secretName]
        else process.env[secretName] = previousSecret
        await rm(directory, { recursive: true, force: true })
    }
})

test('first-run Access Key initialization is validated, atomic, and one-time', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-setup-'))
    const workspaceRoot = path.join(directory, 'repos')
    const configPath = path.join(directory, 'nexus-agentd.json')
    await mkdir(workspaceRoot)
    await writeFile(
        configPath,
        JSON.stringify({
            initialized: false,
            workspaceRoots: [workspaceRoot],
            agents: {}
        })
    )

    try {
        const config = await loadAgentdConfig(configPath)
        const sessions = new SessionManager(
            config,
            await WorkspacePolicy.create(config.workspaceRoots),
            createDriverRegistry(config)
        )
        const control = new AgentdControlPlane(configPath, config, sessions)

        assert.equal(control.isInitialized(), false)
        assert.equal(control.accessKey(), undefined)
        await assert.rejects(
            () => control.initializeAccessKey('1234567', '1234567'),
            /at least 8 characters/
        )
        await assert.rejects(
            () => control.initializeAccessKey('abcdefgh', 'abcdefgi'),
            /confirmation does not match/
        )
        await assert.rejects(
            () => control.initializeAccessKey('env:NOT_ALLOWED', 'env:NOT_ALLOWED'),
            /literal value/
        )

        const attempts = await Promise.allSettled([
            control.initializeAccessKey('first-key-123', 'first-key-123'),
            control.initializeAccessKey('second-key-456', 'second-key-456')
        ])
        assert.equal(
            attempts.filter((attempt) => attempt.status === 'fulfilled').length,
            1
        )
        const rejected = attempts.find(
            (attempt): attempt is PromiseRejectedResult =>
                attempt.status === 'rejected'
        )
        assert.ok(rejected)
        assert.ok(rejected.reason instanceof ControlPlaneError)
        assert.equal(rejected.reason.status, 409)

        const persisted = JSON.parse(await readFile(configPath, 'utf8'))
        assert.equal(persisted.initialized, true)
        assert.equal(persisted.authToken, control.accessKey())
        const reloaded = await loadAgentdConfig(configPath)
        assert.equal(reloaded.initialized, true)
        assert.equal(reloaded.authToken, control.accessKey())
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})
