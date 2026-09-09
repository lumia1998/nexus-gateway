import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hashAdminPassword } from '../src/auth.js'
import { loadAgentdConfig } from '../src/config.js'
import { AgentdControlPlane } from '../src/control-plane.js'
import { closeServer as closeAgentdServer } from '../src/index.js'
import { createAgentdServer } from '../src/server.js'
import { RunStore, runStorePathForConfig } from '../src/run-store.js'
import { SessionManager } from '../src/session.js'
import { WorkspacePolicy } from '../src/workspace.js'

const DAY_MS = 24 * 60 * 60 * 1000

test('serves persisted artifacts over owner and admin HTTP auth after restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifact-http-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    const runFile = runStorePathForConfig(configPath)
    const artifactRoot = path.join(directory, 'artifact-root')
    const adminPassword = 'artifact-http-admin-password'
    let now = 1_000_000

    await writeFile(
        configPath,
        JSON.stringify({
            initialized: true,
            listen: { host: '127.0.0.1', port: 8787 },
            adminPasswordHash: await hashAdminPassword(adminPassword),
            workspaceRoots: [directory],
            apiKeys: [
                {
                    id: 'owner-key',
                    name: 'Artifact owner',
                    secret: 'nx_sk_owner_artifact_secret',
                    enabled: true,
                    scope: { allAgents: false, agentIds: ['artifact-agent'] },
                    createdAt: 1
                },
                {
                    id: 'other-key',
                    name: 'Other owner',
                    secret: 'nx_sk_other_artifact_secret',
                    enabled: true,
                    scope: { allAgents: true, agentIds: [] },
                    createdAt: 2
                },
                {
                    id: 'scope-key',
                    name: 'Wrong scope',
                    secret: 'nx_sk_scope_artifact_secret',
                    enabled: true,
                    scope: { allAgents: false, agentIds: ['other-agent'] },
                    createdAt: 3
                }
            ],
            agents: {
                'artifact-agent': {
                    protocol: 'acp',
                    driver: 'codex',
                    workspace: directory
                },
                'other-agent': {
                    protocol: 'acp',
                    driver: 'codex',
                    workspace: directory
                }
            }
        }, null, 2),
        'utf8'
    )

    const config = await loadAgentdConfig(configPath)
    const storeOptions = {
        rootDir: artifactRoot,
        retentionDays: 1,
        now: () => now
    }
    const firstStore = new RunStore(runFile, storeOptions)
    let restartedStore: RunStore | undefined
    let sessions: SessionManager | undefined
    let server: ReturnType<typeof createAgentdServer> | undefined
    let control: AgentdControlPlane | undefined

    const runInput = (sessionId: string, agentId: string, ownerKeyId: string, task: string) => ({
        sessionId,
        agentId,
        agentName: 'Artifact Agent',
        protocol: 'acp' as const,
        ownerKeyId,
        task
    })

    try {
        await firstStore.init()

        const expiredRun = firstStore.create(
            runInput('expired-session', 'artifact-agent', 'owner-key', 'expired artifact')
        )
        firstStore.recordArtifacts(expiredRun.id, [
            { id: 'expired', filename: 'expired.txt', mediaType: 'text/plain', text: 'expired payload' }
        ])
        firstStore.update(expiredRun.id, {
            state: 'completed',
            output: 'expired run complete',
            endedAt: now
        })
        await firstStore.flush()

        // Move the clock past the first run's retention window before creating
        // the durable run that should remain downloadable after restart.
        now += 2 * DAY_MS
        const durableRun = firstStore.create(
            runInput('durable-session', 'artifact-agent', 'owner-key', 'durable artifacts')
        )
        firstStore.recordArtifacts(durableRun.id, [
            {
                id: 'text',
                filename: 'answer.txt',
                mediaType: 'text/plain',
                text: 'hello after restart'
            },
            {
                id: 'bytes',
                filename: 'payload.bin',
                mediaType: 'application/octet-stream',
                bytesBase64: Buffer.from([0, 1, 2, 255]).toString('base64')
            },
            {
                id: 'remote',
                filename: 'remote.bin',
                mediaType: 'application/octet-stream',
                url: 'https://example.invalid/must-not-fetch',
                metadata: { source: 'remote' }
            }
        ])
        firstStore.update(durableRun.id, {
            state: 'completed',
            output: 'durable run complete',
            endedAt: now
        })

        const scopeRun = firstStore.create(
            runInput('scope-session', 'artifact-agent', 'scope-key', 'scope protected artifact')
        )
        firstStore.recordArtifacts(scopeRun.id, [
            { id: 'scope', filename: 'scope.txt', text: 'scope protected' }
        ])
        firstStore.update(scopeRun.id, {
            state: 'completed',
            endedAt: now
        })
        await firstStore.flush()

        restartedStore = new RunStore(runFile, storeOptions)
        await restartedStore.init()
        assert.equal(restartedStore.get(durableRun.id)?.state, 'completed')
        assert.equal(restartedStore.artifactViews(durableRun.id)?.find((item) => item.id === 'text')?.storageStatus, 'available')
        assert.equal(restartedStore.artifactViews(durableRun.id)?.find((item) => item.id === 'bytes')?.storageStatus, 'available')
        assert.equal(restartedStore.get(expiredRun.id)?.state, 'completed')

        sessions = new SessionManager(
            config,
            await WorkspacePolicy.create(config.workspaceRoots),
            new Map(),
            restartedStore
        )
        assert.equal(sessions.count(), 0)
        control = new AgentdControlPlane(configPath, config, sessions)
        server = createAgentdServer(config, sessions, control)
        await new Promise<void>((resolve, reject) => {
            server!.once('error', reject)
            server!.listen(0, '127.0.0.1', resolve)
        })
        const port = (server.address() as AddressInfo).port
        const base = `http://127.0.0.1:${port}`

        const textResponse = await fetch(
            `${base}/v1/runs/${durableRun.id}/artifacts/text`,
            { headers: { Authorization: 'Bearer nx_sk_owner_artifact_secret' } }
        )
        assert.equal(textResponse.status, 200)
        assert.equal(await textResponse.text(), 'hello after restart')
        assert.equal(textResponse.headers.get('content-type'), 'text/plain')
        assert.match(textResponse.headers.get('content-disposition') || '', /^attachment;/)
        assert.equal(textResponse.headers.get('x-content-type-options'), 'nosniff')

        const bytesResponse = await fetch(
            `${base}/v1/runs/${durableRun.id}/artifacts/bytes`,
            { headers: { Authorization: 'Bearer nx_sk_owner_artifact_secret' } }
        )
        assert.equal(bytesResponse.status, 200)
        assert.deepEqual(
            Buffer.from(await bytesResponse.arrayBuffer()),
            Buffer.from([0, 1, 2, 255])
        )

        const otherOwnerResponse = await fetch(
            `${base}/v1/runs/${durableRun.id}/artifacts/text`,
            { headers: { Authorization: 'Bearer nx_sk_other_artifact_secret' } }
        )
        assert.equal(otherOwnerResponse.status, 404)

        const wrongScopeResponse = await fetch(
            `${base}/v1/runs/${scopeRun.id}/artifacts/scope`,
            { headers: { Authorization: 'Bearer nx_sk_scope_artifact_secret' } }
        )
        assert.equal(wrongScopeResponse.status, 403)

        const metadataResponse = await fetch(
            `${base}/v1/runs/${durableRun.id}/artifacts/remote`,
            { headers: { Authorization: 'Bearer nx_sk_owner_artifact_secret' } }
        )
        assert.equal(metadataResponse.status, 404)

        const expiredResponse = await fetch(
            `${base}/v1/runs/${expiredRun.id}/artifacts/expired`,
            { headers: { Authorization: 'Bearer nx_sk_owner_artifact_secret' } }
        )
        assert.equal(expiredResponse.status, 404)

        const loginResponse = await fetch(`${base}/v1/admin/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: base
            },
            body: JSON.stringify({ password: adminPassword })
        })
        assert.equal(loginResponse.status, 200)
        const cookie = (loginResponse.headers.get('set-cookie') || '').split(';', 1)[0]
        assert.match(cookie, /^agent_nexus_admin=/)

        const adminResponse = await fetch(
            `${base}/v1/admin/runs/${durableRun.id}/artifacts/text`,
            { headers: { Cookie: cookie } }
        )
        assert.equal(adminResponse.status, 200)
        assert.equal(await adminResponse.text(), 'hello after restart')
        assert.match(adminResponse.headers.get('content-disposition') || '', /^attachment;/)
        assert.equal(adminResponse.headers.get('x-content-type-options'), 'nosniff')
    } finally {
        if (server) await closeAgentdServer(server).catch(() => undefined)
        if (sessions) await sessions.shutdown().catch(() => undefined)
        if (restartedStore) await restartedStore.flush().catch(() => undefined)
        await firstStore.flush().catch(() => undefined)
        const usageTimer = (control as unknown as { usageTimer?: NodeJS.Timeout } | undefined)?.usageTimer
        if (usageTimer) clearTimeout(usageTimer)
        await rm(directory, { recursive: true, force: true })
    }
})
