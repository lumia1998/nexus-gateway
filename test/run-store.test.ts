import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore, runStorePathForConfig } from '../src/run-store.js'
import { ManagedSession } from '../src/session.js'

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
            history.runs.map((run) => run.task),
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
