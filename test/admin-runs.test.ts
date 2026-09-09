import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/run-store.js'
import { AdminRunManager } from '../src/session/admin-runs.js'
import {
    ManagedSession,
    SessionManager,
    SessionRequestError
} from '../src/session.js'
import type { AgentdConfig } from '../src/types.js'
import { WorkspacePolicy } from '../src/workspace.js'

test('run controls guard the current turn under the session lock', async () => {
    const fixture = await fixtureForRunActions()
    const session = fixture.session('owner-a')
    const runtime = runtimeFor(session)
    session.attach(runtime)
    fixture.add(session)
    try {
        const first = await fixture.manager.message(session.id, 'first')
        const firstRunId = first.runId!
        session.setState('completed')
        const second = await fixture.manager.message(session.id, 'second')
        const secondRunId = second.runId!

        await assert.rejects(
            () => fixture.manager.cancelRun(firstRunId),
            (error: unknown) =>
                error instanceof SessionRequestError &&
                error.status === 409 &&
                /current session turn/.test(error.message)
        )
        assert.equal(fixture.manager.getRun(secondRunId).state, 'running')

        const canceled = await fixture.manager.cancelRun(secondRunId)
        assert.equal(canceled.run.id, secondRunId)
        assert.equal(canceled.run.state, 'canceled')
        assert.equal(canceled.controls.canCancel, false)
    } finally {
        await fixture.close()
    }
})

test('expired permission requests cannot be answered by an administrator', async () => {
    const fixture = await fixtureForRunActions()
    const session = fixture.session('owner-a')
    session.attach({
        ...runtimeFor(session),
        async prompt() {
            session.setPending({
                id: 'permission-1',
                kind: 'permission',
                prompt: 'Allow the tool?'
            })
        }
    })
    fixture.add(session)
    try {
        const created = await fixture.manager.message(session.id, 'needs permission')
        const runId = created.runId!
        await until(() => Boolean(session.pendingRequest))
        const controls = fixture.manager.getRunControls(runId)
        assert.equal(controls.canCancel, true)
        assert.equal(controls.pendingRequest?.id, 'permission-1')

        session.clearPending()
        session.setState('failed', 'ACP permission request timed out')
        await assert.rejects(
            () =>
                fixture.manager.respondRun(runId, {
                    requestId: 'permission-1',
                    action: 'accept'
                }),
            (error: unknown) =>
                error instanceof SessionRequestError && error.status === 409
        )
        assert.equal(fixture.manager.getRun(runId).state, 'failed')
    } finally {
        await fixture.close()
    }
})

test('terminal runs reject cancellation without changing their failure state', async () => {
    const fixture = await fixtureForRunActions()
    const session = fixture.session('owner-a')
    session.attach(runtimeFor(session))
    fixture.add(session)
    try {
        const created = await fixture.manager.message(session.id, 'already failed')
        const runId = created.runId!
        session.setState('failed', 'agent stopped')
        await assert.rejects(
            () => fixture.manager.cancelRun(runId),
            (error: unknown) =>
                error instanceof SessionRequestError && error.status === 409
        )
        assert.equal(fixture.manager.getRun(runId).state, 'failed')
    } finally {
        await fixture.close()
    }
})

test('retry preserves the persisted owner, records the relation, and deduplicates', async () => {
    const fixture = await fixtureForRunActions()
    const source = fixture.session('original-owner')
    source.attach(runtimeFor(source))
    fixture.add(source)
    try {
        const created = await fixture.manager.message(source.id, 'retry me')
        const oldRunId = created.runId!
        source.appendOutput('done')
        source.setState('completed')
        // The historical run can be retried in a new session even while its
        // original session is already processing a newer turn.
        await fixture.manager.message(source.id, 'newer turn')
        assert.equal(fixture.manager.getRunControls(oldRunId).canRetry, true)

        ;(fixture.manager as any).create = async (
            agentId: string,
            workspace: string | undefined,
            ownerKeyId: string
        ) => {
            const retried = fixture.session(ownerKeyId, agentId, workspace)
            retried.attach(runtimeFor(retried))
            fixture.add(retried)
            return retried.snapshot()
        }

        const result = await fixture.manager.retryRun(oldRunId)
        assert.equal(result.retryOfRunId, oldRunId)
        assert.notEqual(result.run.id, oldRunId)
        assert.equal(result.run.task, 'retry me')
        assert.equal(
            fixture.manager.getRunOwnerKeyId(result.run.id),
            'original-owner'
        )
        assert.equal(fixture.store.get(result.run.id)?.retryOfRunId, oldRunId)

        const duplicate = await fixture.manager.retryRun(oldRunId)
        assert.equal(duplicate.run.id, result.run.id)
        assert.equal(duplicate.sessionId, result.sessionId)
    } finally {
        await fixture.close()
    }
})

test('retry rejects active, truncated, and attachment-bearing history', async () => {
    const fixture = await fixtureForRunActions(4)
    try {
        const active = fixture.store.create({
            sessionId: 'missing-active-session',
            agentId: 'agent',
            agentName: 'Agent',
            protocol: 'acp',
            ownerKeyId: 'owner',
            task: 'active'
        })
        await assert.rejects(
            () => fixture.manager.retryRun(active.id),
            (error: unknown) =>
                error instanceof SessionRequestError && error.status === 409
        )

        const truncated = fixture.store.create({
            sessionId: 'missing-truncated-session',
            agentId: 'agent',
            agentName: 'Agent',
            protocol: 'acp',
            ownerKeyId: 'owner',
            task: 'this task is truncated'
        })
        fixture.store.update(truncated.id, { state: 'failed' })
        await assert.rejects(
            () => fixture.manager.retryRun(truncated.id),
            (error: unknown) =>
                error instanceof SessionRequestError &&
                /truncated/.test(error.message)
        )

        const withAttachment = fixture.store.create({
            sessionId: 'missing-attachment-session',
            agentId: 'agent',
            agentName: 'Agent',
            protocol: 'acp',
            ownerKeyId: 'owner',
            task: 'att',
            inputAttachmentCount: 1
        })
        fixture.store.update(withAttachment.id, { state: 'canceled' })
        await assert.rejects(
            () => fixture.manager.retryRun(withAttachment.id),
            (error: unknown) =>
                error instanceof SessionRequestError &&
                /input attachments/.test(error.message)
        )
    } finally {
        await fixture.close()
    }
})

test('a failed retry releases the per-run guard for a later attempt', async () => {
    const fixture = await fixtureForRunActions()
    const source = fixture.session('owner-a')
    source.attach(runtimeFor(source))
    fixture.add(source)
    try {
        const created = await fixture.manager.message(source.id, 'retry failure')
        const oldRunId = created.runId!
        source.setState('failed', 'original failure')
        let attempts = 0
        ;(fixture.manager as any).create = async () => {
            attempts++
            throw new SessionRequestError(429, 'Session capacity has been reached')
        }

        await assert.rejects(() => fixture.manager.retryRun(oldRunId), /capacity/)
        await assert.rejects(() => fixture.manager.retryRun(oldRunId), /capacity/)
        assert.equal(attempts, 2)
    } finally {
        await fixture.close()
    }
})

test('a concurrent retry is rejected while the first retry is starting', async () => {
    const fixture = await fixtureForRunActions()
    const source = fixture.session('owner-a')
    source.attach(runtimeFor(source))
    fixture.add(source)
    try {
        const created = await fixture.manager.message(source.id, 'retry once')
        const oldRunId = created.runId!
        source.setState('completed')

        let releaseCreate!: () => void
        const createGate = new Promise<void>((resolve) => {
            releaseCreate = resolve
        })
        let enteredCreate!: () => void
        const createEntered = new Promise<void>((resolve) => {
            enteredCreate = resolve
        })
        ;(fixture.manager as any).create = async (
            agentId: string,
            workspace: string | undefined,
            ownerKeyId: string
        ) => {
            enteredCreate()
            await createGate
            const retried = fixture.session(ownerKeyId, agentId, workspace)
            retried.attach(runtimeFor(retried))
            fixture.add(retried)
            return retried.snapshot()
        }

        const first = fixture.manager.retryRun(oldRunId)
        await createEntered
        assert.equal(fixture.manager.getRunControls(oldRunId).canRetry, false)
        assert.match(
            fixture.manager.getRunControls(oldRunId).unavailableReason || '',
            /already in progress/
        )
        await assert.rejects(
            () => fixture.manager.retryRun(oldRunId),
            (error: unknown) =>
                error instanceof SessionRequestError &&
                error.status === 409 &&
                /already in progress/.test(error.message)
        )
        releaseCreate()
        const result = await first
        assert.equal(result.retryOfRunId, oldRunId)
    } finally {
        await fixture.close()
    }
})

test('retry dedupe state is bounded and drops evicted retry targets', async () => {
    const runs = new Map<string, any>()
    let retrySequence = 0
    const source = adminRun('source')
    const secondSource = adminRun('source-2')
    const staleSource = adminRun('stale-source')
    runs.set(source.id, source)
    runs.set(secondSource.id, secondSource)
    runs.set(staleSource.id, staleSource)

    const manager = new AdminRunManager({
        getRun(runId) {
            const run = runs.get(runId)
            if (!run) {
                const error = new SessionRequestError(404, `Run not found: ${runId}`)
                throw error
            }
            return structuredClone(run)
        },
        getSession() {
            return undefined
        },
        getAgent() {
            return { enabled: true } as any
        },
        getOwnerKeyId() {
            return 'original-owner'
        },
        withSessionLock(_sessionId, operation) {
            return operation()
        },
        async startRetry(run, _ownerKeyId) {
            const runId = `retry-${++retrySequence}`
            const retried = adminRun(runId, 'running')
            retried.sessionId = `session-${runId}`
            retried.task = run.task
            runs.set(runId, retried)
            return { runId, sessionId: retried.sessionId }
        },
        requestError(status, message) {
            return new SessionRequestError(status, message)
        },
        maxRetryRecords: 1,
        retryRecordTtlMs: 60_000
    })

    const first = await manager.retryRun(source.id)
    await manager.retryRun(secondSource.id)
    assert.equal((manager as any).retryRecords.size, 1)
    assert.equal(manager.retryOfRunId(first.run.id), undefined)

    const stale = await manager.retryRun(staleSource.id)
    runs.delete(stale.run.id)
    assert.equal(manager.retryOfRunId(stale.run.id), undefined)
    const retriedAgain = await manager.retryRun(staleSource.id)
    assert.notEqual(retriedAgain.run.id, stale.run.id)
})

test('retry reservation is rolled back on failure and skipped for a duplicate', async () => {
    const runs = new Map<string, any>()
    const source = adminRun('reservation-source')
    runs.set(source.id, source)
    let fail = true
    let starts = 0
    let reservations = 0
    let releases = 0
    const manager = new AdminRunManager({
        getRun(runId) {
            const run = runs.get(runId)
            if (!run) throw new SessionRequestError(404, `Run not found: ${runId}`)
            return structuredClone(run)
        },
        getSession() {
            return undefined
        },
        getAgent() {
            return { enabled: true } as any
        },
        getOwnerKeyId() {
            return 'owner'
        },
        withSessionLock(_sessionId, operation) {
            return operation()
        },
        async startRetry(run, _ownerKeyId, reservation) {
            starts++
            if (fail) throw new SessionRequestError(502, 'retry start failed')
            const retried = adminRun('reservation-retry', 'running')
            retried.sessionId = 'reservation-session'
            retried.task = run.task
            runs.set(retried.id, retried)
            reservation?.bind(retried.sessionId)
            return { runId: retried.id, sessionId: retried.sessionId }
        },
        requestError(status, message) {
            return new SessionRequestError(status, message)
        }
    })
    const reserveRetry = () => {
        reservations++
        let released = false
        return {
            bind() {},
            release() {
                if (!released) {
                    released = true
                    releases++
                }
            }
        }
    }

    await assert.rejects(
        () => manager.retryRun(source.id, reserveRetry),
        /retry start failed/
    )
    assert.equal(reservations, 1)
    assert.equal(releases, 1)

    fail = false
    const result = await manager.retryRun(source.id, reserveRetry)
    assert.equal(result.run.id, 'reservation-retry')
    assert.equal(reservations, 2)
    assert.equal(releases, 1)

    const duplicate = await manager.retryRun(source.id, reserveRetry)
    assert.equal(duplicate.run.id, result.run.id)
    assert.equal(reservations, 2)
    assert.equal(starts, 2)
})

interface RunFixture {
    manager: SessionManager
    store: RunStore
    session(owner: string, agentId?: string, workspace?: string): ManagedSession
    add(session: ManagedSession): void
    close(): Promise<void>
}

async function fixtureForRunActions(maxTaskChars = 1024 * 1024): Promise<RunFixture> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-admin-runs-'))
    const store = new RunStore(path.join(directory, 'runs.json'), 100, maxTaskChars)
    await store.init()
    const manager = new SessionManager(
        {
            agents: {
                agent: {
                    protocol: 'acp',
                    driver: 'stdio',
                    enabled: true,
                    workspace: directory
                }
            },
            workspaceRoots: [directory],
            maxSessions: 8,
            maxEventsPerSession: 64,
            maxOutputChars: 64 * 1024,
            sessionTtlMs: 60_000,
            cleanupIntervalMs: 60_000
        } as AgentdConfig,
        await WorkspacePolicy.create([directory]),
        new Map(),
        store
    )
    return {
        manager,
        store,
        session(owner, agentId = 'agent', workspace = directory) {
            return new ManagedSession(
                agentId,
                'acp',
                workspace,
                owner,
                64,
                64 * 1024,
                'Agent',
                store
            )
        },
        add(session) {
            ;(manager as any).sessions.set(session.id, session)
        },
        async close() {
            await manager.shutdown().catch(() => undefined)
            await store.flush()
            await rm(directory, { recursive: true, force: true })
        }
    }
}

function runtimeFor(session: ManagedSession) {
    return {
        isAvailable: () => true,
        async start() {},
        async prompt() {},
        async respondPending() {
            session.clearPending()
            session.setState('running')
        },
        async cancel() {},
        async dispose() {}
    }
}

function adminRun(id: string, state: 'running' | 'completed' = 'completed') {
    return {
        id,
        sessionId: `session-${id}`,
        agentId: 'agent',
        agentName: 'Agent',
        protocol: 'acp',
        workspace: '/workspace',
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

async function until(check: () => boolean) {
    const deadline = Date.now() + 2_000
    while (!check()) {
        if (Date.now() >= deadline) throw new Error('test deadline exceeded')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}
