import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore, runStorePathForConfig } from '../src/run-store.js'
import { ManagedSession } from '../src/session.js'

test('run list bounds large task/error/progress payloads while detail and full-text search retain content', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-list-budget-'))
    const store = new RunStore(path.join(directory, 'runs.json'))
    try {
        await store.init()
        const task = 'x'.repeat(100_000) + 'tail-search-marker'
        for (let n = 0; n < 60; n++) {
            const run = store.create({ sessionId: String(n), agentId: 'agent', agentName: 'Agent', protocol: 'acp', ownerKeyId: 'owner', task })
            store.update(run.id, { error: task, progress: { phase: 'running', message: task, percent: 42 } })
        }
        const list = store.list({ query: 'tail-search-marker' })
        assert.equal(list.total, 60)
        assert.equal(list.runs.length, 50)
        assert.ok(Buffer.byteLength(JSON.stringify(list)) < 110_000)
        assert.equal(list.runs[0].taskPreview.length, 240)
        assert.equal('task' in list.runs[0], false)
        assert.equal(list.runs[0].progress.percent, 42)
        const detail = store.get(list.runs[0].id)!
        assert.equal(detail.task, task)
        assert.equal(detail.error, task)
        assert.equal(detail.progress.message, task)
    } finally {
        await store.flush()
        await rm(directory, { recursive: true, force: true })
    }
})

test('run statistics cover all matching records before the page limit', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-stats-'))
    const store = new RunStore(path.join(directory, 'runs.json'))
    try {
        await store.init()
        for (let index = 0; index < 240; index++) {
            const run = store.create({ sessionId: String(index), agentId: index < 120 ? 'alpha' : 'beta', agentName: 'Agent', protocol: 'acp', ownerKeyId: 'owner', task: `Task ${index}` })
            const state = index % 4 === 0 ? 'completed' : index % 4 === 1 ? 'failed' : index % 4 === 2 ? 'canceled' : 'permission_required'
            store.update(run.id, { state })
        }
        const page = store.list({ limit: 200 })
        assert.equal(page.runs.length, 200)
        assert.equal(page.total, 240)
        const second = store.list({ limit: 200, offset: 200 })
        assert.equal(second.runs.length, 40)
        assert.equal(new Set([...page.runs, ...second.runs].map((run) => run.id)).size, 240)
        const oldest = second.runs.at(-1)!
        assert.equal(store.list({ query: oldest.id }).runs.some((run) => run.id === oldest.id), true)
        store.update(oldest.id, { output: 'new output' })
        assert.deepEqual(store.list({ limit: 200, offset: 200 }).runs.map((run) => run.id), second.runs.map((run) => run.id))
        assert.deepEqual(page.stats, { active: 60, completed: 60, failed: 60 })
        assert.deepEqual(store.list({ agentId: 'alpha', limit: 1 }).stats, { active: 30, completed: 30, failed: 30 })
        assert.deepEqual(store.list({ state: 'failed', limit: 1 }).stats, { active: 0, completed: 0, failed: 60 })
        assert.deepEqual(store.list({ query: 'missing' }).stats, { active: 0, completed: 0, failed: 0 })
    } finally {
        await store.flush()
        await rm(directory, { recursive: true, force: true })
    }
})

test('persists run history separately and closes stale active runs on restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-runs-'))
    const configPath = path.join(directory, 'nexus-agentd.json')
    const file = runStorePathForConfig(configPath)
    try {
        assert.equal(file, path.join(directory, 'nexus-agentd-runs.json'))
        const first = new RunStore(file, 10)
        await first.init()
        const run = first.create({
            sessionId: 'session-1',
            agentId: 'hermes',
            agentName: 'Hermes',
            protocol: 'acp',
            ownerKeyId: 'key-secret-id',
            task: '  保留空格\n和换行  '
        })
        first.update(run.id, {
            progress: { phase: '执行工具', message: '读取文件' },
            output: '部分输出'
        })
        await first.flush()

        const persisted = JSON.parse(await readFile(file, 'utf8'))
        assert.equal(persisted.schemaVersion, 1)
        assert.equal(persisted.runs[0].task, '  保留空格\n和换行  ')

        const second = new RunStore(file, 10)
        await second.init()
        const restored = second.get(run.id)!
        assert.equal(restored.state, 'failed')
        assert.match(restored.error || '', /restarted/)
        assert.equal(restored.progress.phase, '已中断')
        assert.equal(JSON.stringify(restored).includes('key-secret-id'), false)
        await second.flush()
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('retains the last complete history and retries after an atomic rename conflict', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-history-retry-'))
    const file = path.join(directory, 'runs.json')
    const backup = `${file}.previous`
    const store = new RunStore(file, 10)
    let conflict = false
    let backupExists = false
    try {
        await store.init()
        const first = store.create({
            sessionId: 'session-1',
            agentId: 'agent',
            agentName: 'Agent',
            protocol: 'acp',
            ownerKeyId: 'owner',
            task: 'first persisted run'
        })
        store.update(first.id, { state: 'completed', endedAt: Date.now() })
        await store.flush()
        const original = await readFile(file)

        await rename(file, backup)
        backupExists = true
        await mkdir(file)
        conflict = true
        store.create({
            sessionId: 'session-2',
            agentId: 'agent',
            agentName: 'Agent',
            protocol: 'acp',
            ownerKeyId: 'owner',
            task: 'second run after retry'
        })
        await assert.rejects(() => store.flush())
        assert.deepEqual(await readFile(backup), original)
        assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false)
        assert.equal(store.metrics().writeFailures, 1)

        await rm(file, { recursive: true, force: true })
        conflict = false
        await rename(backup, file)
        backupExists = false
        await store.flush()
        const recovered = JSON.parse(await readFile(file, 'utf8'))
        assert.equal(recovered.runs.length, 2)
        assert.equal(recovered.runs.some((run: { task: string }) => run.task === 'second run after retry'), true)
    } finally {
        if (conflict) await rm(file, { recursive: true, force: true }).catch(() => undefined)
        if (backupExists) await rename(backup, file).catch(() => undefined)
        await store.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})

test('creates one run for each delegated task and tracks real session progress', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-session-runs-'))
    const store = new RunStore(path.join(directory, 'runs.json'), 10)
    try {
        await store.init()
        const session = new ManagedSession(
            'hermes',
            'acp',
            '/workspace',
            'owner-key',
            64,
            64 * 1024,
            'Hermes Agent',
            store
        )
        session.attach({
            async start() {},
            async prompt(message: string) {
                session.setState('running')
                session.emit('tool_call', { title: '读取项目文件' })
                session.appendOutput(`完成：${message}`)
                session.setState('completed')
            },
            async respondPending() {},
            async cancel() {
                session.setState('canceled')
            },
            async dispose() {}
        })

        await session.message('  第一项任务  ')
        await session.message('第二项任务')
        const history = store.list({ agentId: 'hermes', limit: 10 })
        assert.equal(history.total, 2)
        assert.deepEqual(
            history.runs.map((run) => run.taskPreview),
            ['第二项任务', '  第一项任务  ']
        )
        assert.ok(history.runs.every((run) => run.state === 'completed'))
        assert.equal(history.runs[0].progress.phase, '已完成')
        assert.equal(store.get(history.runs[0].id)?.output, '完成：第二项任务')
    } finally {
        await store.flush()
        await rm(directory, { recursive: true, force: true })
    }
})

test('history retention and byte budget prune terminal runs while protecting active runs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-history-retention-'))
    let now = 1_000
    const store = new RunStore(path.join(directory, 'runs.json'), {
        maxRuns: 10,
        maxTaskChars: 8_000,
        historyRetentionDays: 1,
        historyMaxBytes: 1_000,
        now: () => now,
        rootDir: path.join(directory, 'artifacts')
    })
    try {
        await store.init()
        const old = store.create({ sessionId: 'old', agentId: 'agent', agentName: 'Agent', protocol: 'acp', ownerKeyId: 'owner', task: 'old run' })
        store.update(old.id, { state: 'completed', endedAt: now })
        now += 2 * 24 * 60 * 60 * 1000
        const active = store.create({ sessionId: 'active', agentId: 'agent', agentName: 'Agent', protocol: 'acp', ownerKeyId: 'owner', task: 'a'.repeat(2_000) })
        store.update(active.id, { progress: { phase: 'running' } })
        assert.equal(store.get(old.id), undefined)
        assert.equal(store.get(active.id)?.state, 'running')
    } finally {
        await store.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})
