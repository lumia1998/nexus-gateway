import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile as fsReadFile, rm, writeFile as fsWriteFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RunStore } from '../src/run-store.js'

function input(task = 'artifact test') {
    return {
        sessionId: 'session',
        agentId: 'agent',
        agentName: 'Agent',
        protocol: 'acp' as const,
        ownerKeyId: 'owner',
        task
    }
}

test('persists text, binary, JSON data, and metadata-only URL artifacts without fetching URLs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifacts-'))
    const file = path.join(directory, 'runs.json')
    const store = new RunStore(file, 10, 1024 * 1024, {
        artifactRootDir: path.join(directory, 'artifact-root'),
        retentionDays: 30
    })
    try {
        await store.init()
        const run = store.create(input())
        const queued = store.recordArtifacts(run.id, [
            { id: 'text', filename: '../answer.txt', text: 'hello artifact', mediaType: 'text/plain' },
            { id: 'binary', bytesBase64: Buffer.from([0, 1, 2, 255]).toString('base64'), filename: 'blob.bin' },
            { id: 'json', data: { answer: 42 }, filename: 'answer.json', mediaType: 'application/json' },
            { id: 'remote', url: 'http://127.0.0.1:1/must-not-fetch', filename: 'remote.bin' }
        ])!
        assert.equal(queued.length, 4)
        assert.ok(store.metrics().pendingWrites >= 0)
        assert.equal(store.artifactViews(run.id)!.find((item) => item.id === 'remote')?.storageStatus, 'metadata_only')
        assert.equal(store.artifactViews(run.id)!.find((item) => item.id === 'remote')?.downloadable, false)
        await store.flush()
        assert.equal(store.metrics().pendingWrites, 0)
        assert.equal(store.metrics().artifactStoreStats.totalPayloadBytes, 31)

        const views = store.artifactViews(run.id)!
        assert.equal(views.find((item) => item.id === 'text')?.storageStatus, 'available')
        assert.equal(views.find((item) => item.id === 'binary')?.storageStatus, 'available')
        assert.equal(views.find((item) => item.id === 'json')?.storageStatus, 'available')
        assert.equal(views.find((item) => item.id === 'text')?.filename, 'answer.txt')
        assert.deepEqual((await store.readArtifact(run.id, 'text'))?.bytes.toString(), 'hello artifact')
        assert.deepEqual((await store.readArtifact(run.id, 'binary'))?.bytes, Buffer.from([0, 1, 2, 255]))
        assert.equal((await store.readArtifact(run.id, 'json'))?.bytes.toString(), '{"answer":42}')
        assert.equal(await store.readArtifact(run.id, 'remote'), undefined)

        store.update(run.id, { state: 'completed', endedAt: Date.now() })
        await store.flush()
        const restarted = new RunStore(file, 10, 1024 * 1024, {
            artifactRootDir: path.join(directory, 'artifact-root')
        })
        await restarted.init()
        assert.equal(restarted.artifactViews(run.id)!.find((item) => item.id === 'text')?.storageStatus, 'available')
        assert.deepEqual((await restarted.readArtifact(run.id, 'text'))?.bytes.toString(), 'hello artifact')
        await restarted.flush()
    } finally {
        await store.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})

test('rejects oversized or tampered payloads during download', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifact-read-bound-'))
    const root = path.join(directory, 'artifacts')
    const store = new RunStore(path.join(directory, 'runs.json'), {
        rootDir: root,
        maxArtifactBytes: 4
    })
    try {
        await store.init()
        const run = store.create(input())
        store.recordArtifacts(run.id, [{ id: 'bounded', text: '1234' }])
        await store.flush()
        const runHash = createHash('sha256').update(run.id).digest('hex').slice(0, 32)
        const artifactHash = createHash('sha256').update('bounded').digest('hex')
        const payload = path.join(root, runHash, `${artifactHash}.bin`)

        await fsWriteFile(payload, Buffer.alloc(5, 0x61))
        assert.equal(await store.readArtifact(run.id, 'bounded'), undefined)
        await fsWriteFile(payload, Buffer.from('wxyz'))
        assert.equal(await store.readArtifact(run.id, 'bounded'), undefined)
    } finally {
        await store.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})

test('bounds per-run payloads, queue bytes, and disk budget while preserving active runs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifact-budget-'))
    const store = new RunStore(path.join(directory, 'runs.json'), {
        rootDir: path.join(directory, 'artifacts'),
        maxArtifactBytes: 4,
        maxArtifactsPerRun: 2,
        maxQueuedBytes: 4,
        maxTotalBytes: 4
    })
    try {
        await store.init()
        const first = store.create(input('first'))
        store.recordArtifacts(first.id, [
            { id: 'one', text: '1234' },
            { id: 'too-large', text: '12345' },
            { id: 'ignored', text: 'x' }
        ])
        store.update(first.id, { state: 'completed', endedAt: Date.now() })
        await store.flush()
        assert.equal(store.artifactViews(first.id)!.length, 2)
        assert.equal(store.artifactViews(first.id)!.find((item) => item.id === 'too-large')?.storageStatus, 'metadata_only')

        const active = store.create(input('active'))
        store.recordArtifacts(active.id, [{ id: 'two', text: 'abcd' }])
        await store.flush()
        assert.equal(store.artifactViews(active.id)!.find((item) => item.id === 'two')?.storageStatus, 'available')
        assert.equal(store.artifactViews(first.id)!.find((item) => item.id === 'one')?.storageStatus, 'evicted')
        assert.equal(store.artifactViews(active.id)!.find((item) => item.id === 'two')?.downloadable, true)
    } finally {
        await store.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})

test('failed artifact writes remain dirty and a later flush retries them', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifact-retry-'))
    let fail = true
    const store = new RunStore(path.join(directory, 'runs.json'), {
        rootDir: path.join(directory, 'artifacts'),
        io: {
            async writeFile(...args: any[]) {
                if (fail && String(args[0]).endsWith('.tmp')) throw new Error('injected artifact IO failure')
                return fsWriteFile(...(args as Parameters<typeof fsWriteFile>))
            }
        }
    })
    try {
        await store.init()
        const run = store.create(input())
        store.recordArtifacts(run.id, [{ id: 'retry', text: 'retry me' }])
        await assert.rejects(() => store.flush(), /injected artifact IO failure/)
        assert.equal(store.artifactViews(run.id)!.find((item) => item.id === 'retry')?.storageStatus, 'pending')
        fail = false
        await store.flush()
        assert.equal(store.artifactViews(run.id)!.find((item) => item.id === 'retry')?.storageStatus, 'available')
        assert.equal((await store.readArtifact(run.id, 'retry'))?.bytes.toString(), 'retry me')
    } finally {
        fail = false
        await store.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})

test('coalesces repeated snapshots while a slow write is in flight', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifact-slow-'))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let payloadWrites = 0
    let blocked = false
    const store = new RunStore(path.join(directory, 'runs.json'), {
        rootDir: path.join(directory, 'artifacts'),
        io: {
            async writeFile(...args: any[]) {
                const target = String(args[0])
                if (target.includes('.bin.')) {
                    payloadWrites++
                    if (!blocked) {
                        blocked = true
                        await gate
                    }
                }
                return fsWriteFile(...(args as Parameters<typeof fsWriteFile>))
            }
        }
    })
    try {
        await store.init()
        const run = store.create(input())
        store.recordArtifacts(run.id, [{ id: 'same', text: 'same', name: 'old' }])
        await new Promise((resolve) => setTimeout(resolve, 10))
        store.recordArtifacts(run.id, [{ id: 'same', text: 'same', name: 'new' }])
        release()
        await store.flush()
        assert.equal(payloadWrites, 1)
        assert.equal(store.artifactViews(run.id)![0].name, 'new')
        assert.equal(store.artifactViews(run.id)![0].storageStatus, 'available')
    } finally {
        release()
        await store.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})

test('retention expiration removes payloads but leaves run metadata', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifact-retention-'))
    let now = 1_000
    const file = path.join(directory, 'runs.json')
    const options = {
        rootDir: path.join(directory, 'artifacts'),
        retentionDays: 1,
        now: () => now
    }
    const first = new RunStore(file, options)
    try {
        await first.init()
        const run = first.create(input())
        first.recordArtifacts(run.id, [{ id: 'old', text: 'old payload' }])
        first.update(run.id, { state: 'completed', endedAt: now })
        await first.flush()
        now += 2 * 24 * 60 * 60 * 1000
        const restarted = new RunStore(file, options)
        await restarted.init()
        assert.equal(restarted.get(run.id)?.artifactCount, 1)
        assert.equal(restarted.artifactViews(run.id)![0].storageStatus, 'expired')
        assert.equal(await restarted.readArtifact(run.id, 'old'), undefined)
        await restarted.flush()
    } finally {
        await first.flush().catch(() => undefined)
        await rm(directory, { recursive: true, force: true })
    }
})
