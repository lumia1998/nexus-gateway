import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { hashAdminPassword } from '../src/auth.js'
import { AgentdControlPlane } from '../src/control-plane.js'
import { closeServer } from '../src/index.js'
import { createAgentdServer } from '../src/server.js'
import type { AgentdConfig, AgentdRunDetail } from '../src/types.js'

test('admin run controls, scoped artifact downloads, diagnostics, and metrics', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-admin-api-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    const password = 'admin-password-for-tests'
    const config: AgentdConfig = {
        listen: { host: '127.0.0.1', port: 0 },
        initialized: true,
        adminPasswordHash: await hashAdminPassword(password),
        apiKeys: [{
            id: 'client-a',
            name: 'Client A',
            secret: 'client-a-secret-value',
            enabled: true,
            scope: { allAgents: false, agentIds: ['agent-a'] },
            createdAt: 1
        }],
        workspaceRoots: [directory],
        maxRequestBytes: 1024 * 1024,
        maxAttachmentBytes: 1024 * 1024,
        maxEventsPerSession: 16,
        maxOutputChars: 64 * 1024,
        sessionTtlMs: 60_000,
        quotas: {
            maxSessionsPerKey: 1,
            maxRunningRunsPerKey: 1,
            maxSsePerKey: 1,
            maxUploadBytesPerKey: 4
        },
        agents: {
            'agent-a': {
                protocol: 'acp',
                driver: 'codex',
                workspace: directory
            }
        }
    }
    await writeFile(configPath, JSON.stringify(config))
    const sessions = new FakeSessions()
    const control = new AgentdControlPlane(configPath, config, sessions as any)
    const server = createAgentdServer(config, sessions as any, control)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}`
    try {
        const login = await fetch(`${base}/v1/admin/auth/login`, {
            method: 'POST',
            headers: { Origin: base, 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        })
        assert.equal(login.status, 200)
        const cookie = login.headers.get('set-cookie') || ''

        const detail = await fetch(`${base}/v1/admin/runs/run-1`, {
            headers: { Cookie: cookie }
        })
        assert.equal(detail.status, 200)
        assert.equal((await detail.json()).controls.canCancel, true)

        const responded = await fetch(`${base}/v1/admin/runs/run-1/respond`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: 'pending-1', message: 'continue' })
        })
        assert.equal(responded.status, 202)

        const canceled = await fetch(`${base}/v1/admin/runs/run-1/cancel`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
            body: '{}'
        })
        assert.equal(canceled.status, 202)

        const retried = await fetch(`${base}/v1/admin/runs/run-1/retry`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
            body: '{}'
        })
        assert.equal(retried.status, 202)
        assert.deepEqual(await retried.json(), { runId: 'run-2', sessionId: 'session-2' })

        const adminArtifact = await fetch(`${base}/v1/admin/runs/run-1/artifacts/artifact-1`, {
            headers: { Cookie: cookie }
        })
        assert.equal(adminArtifact.status, 200)
        assert.equal(await adminArtifact.text(), 'hello')
        assert.match(adminArtifact.headers.get('content-disposition') || '', /attachment/)
        assert.equal(adminArtifact.headers.get('x-content-type-options'), 'nosniff')

        const dataArtifact = await fetch(`${base}/v1/runs/run-1/artifacts/artifact-1`, {
            headers: { Authorization: 'Bearer client-a-secret-value' }
        })
        assert.equal(dataArtifact.status, 200)

        const diagnostic = await fetch(`${base}/v1/admin/agents/agent-a/diagnostics`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
            body: '{}'
        })
        assert.equal(diagnostic.status, 200)
        const diagnosticBody = await diagnostic.json()
        assert.equal(diagnosticBody.ok, true)
        assert.equal(diagnosticBody.status, 'passed')
        assert.deepEqual(diagnosticBody.stages.map((stage: { name: string }) => stage.name), [
            'validate',
            'handshake',
            'close'
        ])

        const firstSession = await fetch(`${base}/v1/sessions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer client-a-secret-value',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ agentId: 'agent-a' })
        })
        assert.equal(firstSession.status, 201)
        const quotaRejected = await fetch(`${base}/v1/sessions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer client-a-secret-value',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ agentId: 'agent-a' })
        })
        assert.equal(quotaRejected.status, 429)
        assert.equal(quotaRejected.headers.get('retry-after'), '1')
        assert.equal((await quotaRejected.json()).quota, 'sessions')

        const metrics = await fetch(`${base}/v1/admin/metrics`, { headers: { Cookie: cookie } })
        assert.equal(metrics.status, 200)
        const metricBody = await metrics.json()
        assert.equal(typeof metricBody.rssBytes, 'number')
        assert.equal(typeof metricBody.runs.total, 'number')
        assert.ok(!JSON.stringify(metricBody).includes('client-a-secret-value'))
    } finally {
        await closeServer(server)
        await rm(directory, { recursive: true, force: true })
    }
})

test('admin retry reserves session and running quota only for a new retry', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-admin-retry-quota-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    const password = 'admin-password-for-retry-quota-tests'
    const config: AgentdConfig = {
        listen: { host: '127.0.0.1', port: 0 },
        initialized: true,
        adminPasswordHash: await hashAdminPassword(password),
        apiKeys: [{
            id: 'client-a',
            name: 'Client A',
            secret: 'client-a-secret-value',
            enabled: true,
            scope: { allAgents: false, agentIds: ['agent-a'] },
            createdAt: 1
        }],
        workspaceRoots: [directory],
        maxRequestBytes: 1024 * 1024,
        maxAttachmentBytes: 1024 * 1024,
        maxEventsPerSession: 16,
        maxOutputChars: 64 * 1024,
        sessionTtlMs: 60_000,
        maxSessions: 8,
        quotas: {
            maxSessionsPerKey: 1,
            maxRunningRunsPerKey: 1,
            maxSsePerKey: 1,
            maxUploadBytesPerKey: 4
        },
        agents: {
            'agent-a': {
                protocol: 'acp',
                driver: 'codex',
                workspace: directory
            }
        }
    }
    await writeFile(configPath, JSON.stringify(config))
    const sessions = new RetryQuotaSessions()
    const control = new AgentdControlPlane(configPath, config, sessions as any)
    const server = createAgentdServer(config, sessions as any, control)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const base = `http://127.0.0.1:${address.port}`
    try {
        const login = await fetch(`${base}/v1/admin/auth/login`, {
            method: 'POST',
            headers: { Origin: base, 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
        })
        assert.equal(login.status, 200)
        const cookie = login.headers.get('set-cookie') || ''
        const retry = (runId: string) => fetch(`${base}/v1/admin/runs/${runId}/retry`, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
            body: '{}'
        })

        const first = await retry('run-1')
        assert.equal(first.status, 202)
        assert.deepEqual(await first.json(), { runId: 'run-2', sessionId: 'session-2' })

        // The running quota is full, but this successful duplicate must be
        // returned from the retry dedupe path before another reservation.
        const duplicate = await retry('run-1')
        assert.equal(duplicate.status, 202)
        assert.deepEqual(await duplicate.json(), { runId: 'run-2', sessionId: 'session-2' })

        const blocked = await fetch(`${base}/v1/sessions`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer client-a-secret-value',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ agentId: 'agent-a' })
        })
        assert.equal(blocked.status, 429)
        assert.equal((await blocked.json()).quota, 'sessions')

        sessions.completeRetry()
        let metrics = await fetch(`${base}/v1/admin/metrics`, { headers: { Cookie: cookie } })
        let metricBody = await metrics.json()
        assert.equal(metricBody.quotas.usage['client-a'].runningRuns, 0)
        assert.equal(metricBody.quotas.usage['client-a'].sessions, 1)

        sessions.closeRetry()
        const failed = await retry('run-failure')
        assert.equal(failed.status, 500)
        metrics = await fetch(`${base}/v1/admin/metrics`, { headers: { Cookie: cookie } })
        metricBody = await metrics.json()
        assert.equal(metricBody.quotas.usage['client-a'] || undefined, undefined)

        const recovered = await retry('run-failure')
        assert.equal(recovered.status, 202)

        sessions.closeRetry()
        const attempts = await Promise.all([
            fetch(`${base}/v1/sessions`, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer client-a-secret-value',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ agentId: 'agent-a' })
            }),
            fetch(`${base}/v1/sessions`, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer client-a-secret-value',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ agentId: 'agent-a' })
            })
        ])
        assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 429])
    } finally {
        await closeServer(server)
        await rm(directory, { recursive: true, force: true })
    }
})

class FakeSessions {
    readonly instanceId = 'test-instance'
    private run: AgentdRunDetail = {
        id: 'run-1',
        sessionId: 'session-1',
        agentId: 'agent-a',
        agentName: 'Agent A',
        protocol: 'acp',
        task: 'task',
        taskPreview: 'task',
        state: 'input_required',
        progress: { phase: '等待输入' },
        artifacts: [{
            id: 'artifact-1',
            name: 'report.txt',
            filename: 'report.txt',
            mediaType: 'text/plain',
            downloadable: true,
            storageStatus: 'available'
        }],
        artifactCount: 1,
        startedAt: Date.now(),
        updatedAt: Date.now()
    }
    private state: any = {
        id: 'session-1',
        runId: 'run-1',
        agentId: 'agent-a',
        protocol: 'acp',
        state: 'input_required',
        artifacts: [],
        pendingRequest: { id: 'pending-1', kind: 'input', prompt: 'Continue?' },
        createdAt: Date.now(),
        updatedAt: Date.now()
    }

    count() { return 1 }
    listRuns() { return { runs: [structuredClone(this.run)], total: 1, stats: { active: 1, completed: 0, failed: 0 } } }
    listAgents() { return [{ id: 'agent-a', name: 'Agent A', protocol: 'acp' as const, ready: true, enabled: true }] }
    getRun(id: string) {
        if (id === 'run-2') return { ...structuredClone(this.run), id: 'run-2', sessionId: 'session-2', state: 'running' as const }
        if (id !== this.run.id) throw new Error('Run not found')
        return structuredClone(this.run)
    }
    getRunOwnerKeyId() { return 'client-a' }
    ownsRun(id: string, key: string) { return id === 'run-1' && key === 'client-a' }
    getRunControls() {
        return { canCancel: this.state.state === 'input_required' || this.state.state === 'running', canRetry: true, pendingRequest: this.state.pendingRequest }
    }
    get() { return structuredClone(this.state) }
    owns(_id: string, key: string) { return key === 'client-a' }
    async respondRun() { this.state.state = 'running'; this.run.state = 'running'; return this.operation() }
    async cancelRun() { this.state.state = 'canceled'; this.run.state = 'canceled'; return this.operation() }
    async retryRun() { return { ...this.operation(), runId: 'run-2', sessionId: 'session-2' } }
    async readRunArtifact() { return { bytes: Buffer.from('hello'), filename: 'report.txt', mediaType: 'text/plain' } }
    async create() { return { ...this.state, id: 'diagnostic-session' } }
    async close() { return this.state }
    reconfigure() {}
    private operation() { return { run: structuredClone(this.run), controls: this.getRunControls(), runId: this.run.id, sessionId: this.run.sessionId } }
}

class RetryQuotaSessions {
    readonly instanceId = 'retry-quota-instance'
    private runs = new Map<string, AgentdRunDetail>()
    private retry?: { runId: string; sessionId: string }
    private listeners = new Set<(event: { type: string; sessionId: string; state?: string }) => void>()
    private failNext = true

    constructor() {
        this.runs.set('run-1', this.run('run-1', 'failed'))
        this.runs.set('run-failure', this.run('run-failure', 'failed'))
    }

    count() { return 1 }
    listRuns() {
        const runs = Array.from(this.runs.values()).map((run) => structuredClone(run))
        return { runs, total: runs.length, stats: { active: 0, completed: 0, failed: runs.length } }
    }
    listAgents() { return [{ id: 'agent-a', name: 'Agent A', protocol: 'acp' as const, ready: true, enabled: true }] }
    getRun(id: string) {
        const run = this.runs.get(id)
        if (!run) throw new Error(`Run not found: ${id}`)
        return structuredClone(run)
    }
    getRunOwnerKeyId() { return 'client-a' }
    ownsRun(id: string, key: string) { return key === 'client-a' && this.runs.has(id) }
    getRunControls() { return { canCancel: false, canRetry: true } }
    get(id: string) {
        return {
            id,
            runId: this.runs.get(id)?.id,
            agentId: 'agent-a',
            protocol: 'acp' as const,
            state: this.runs.get(id)?.state || 'running',
            artifacts: [],
            createdAt: 1,
            updatedAt: 1
        }
    }
    owns() { return true }
    async retryRun(id: string, reserveRetry?: (ownerKeyId: string) => { bind(sessionId: string): void; release(): void }) {
        if (this.retry && id === 'run-1') {
            return { run: this.getRun(this.retry.runId), controls: this.getRunControls(), state: 'running' as const, runId: this.retry.runId, sessionId: this.retry.sessionId }
        }
        const reservation = reserveRetry?.('client-a')
        if (id === 'run-failure' && this.failNext) {
            this.failNext = false
            reservation?.release()
            throw new Error('retry start failed')
        }
        const runId = id === 'run-1' ? 'run-2' : 'run-3'
        const sessionId = id === 'run-1' ? 'session-2' : 'session-3'
        reservation?.bind(sessionId)
        this.retry = { runId, sessionId }
        this.runs.set(runId, this.run(runId, 'running'))
        return { run: this.getRun(runId), controls: this.getRunControls(), state: 'running' as const, runId, sessionId }
    }
    async create() { return this.get('data-session') }
    async close() { return this.get('data-session') }
    reconfigure() {}

    subscribeLifecycle(listener: (event: { type: string; sessionId: string; state?: string }) => void) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    completeRetry() {
        if (!this.retry) return
        const run = this.runs.get(this.retry.runId)
        if (run) run.state = 'completed'
        for (const listener of this.listeners) listener({ type: 'run_updated', sessionId: this.retry.sessionId, state: 'completed' })
    }

    closeRetry() {
        if (!this.retry) return
        const sessionId = this.retry.sessionId
        for (const listener of this.listeners) listener({ type: 'session_closed', sessionId })
        this.retry = undefined
    }

    private run(id: string, state: AgentdRunDetail['state']): AgentdRunDetail {
        return {
            id,
            sessionId: `source-${id}`,
            agentId: 'agent-a',
            agentName: 'Agent A',
            protocol: 'acp',
            task: `task-${id}`,
            taskPreview: `task-${id}`,
            state,
            progress: { phase: state },
            artifacts: [],
            artifactCount: 0,
            startedAt: 1,
            updatedAt: 1
        }
    }
}
