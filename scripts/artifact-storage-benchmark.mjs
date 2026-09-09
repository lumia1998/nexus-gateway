#!/usr/bin/env node

/**
 * Repeatable local benchmark for the asynchronous artifact queue.
 * Run with: npx tsx scripts/artifact-storage-benchmark.mjs [runs] [bytes]
 */
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

const runs = Math.max(1, Number(process.argv[2] || 100))
const bytesPerArtifact = Math.max(1, Number(process.argv[3] || 4096))
const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-artifact-bench-'))
const { RunStore } = await import('../src/run-store.ts')
const store = new RunStore(path.join(directory, 'runs.json'), {
    rootDir: path.join(directory, 'artifacts'),
    maxArtifactBytes: Math.max(12 * 1024 * 1024, bytesPerArtifact),
    maxTotalBytes: Math.max(512 * 1024 * 1024, runs * bytesPerArtifact * 2),
    maxQueuedBytes: Math.max(64 * 1024 * 1024, runs * bytesPerArtifact)
})

try {
    await store.init()
    const payload = Buffer.alloc(bytesPerArtifact, 0x61).toString('base64')
    const started = performance.now()
    for (let index = 0; index < runs; index++) {
        const run = store.create({
            sessionId: `bench-${index}`,
            agentId: 'benchmark',
            agentName: 'Benchmark',
            protocol: 'acp',
            ownerKeyId: 'benchmark',
            task: `artifact benchmark ${index}`
        })
        store.recordArtifacts(run.id, [{
            id: `artifact-${index}`,
            filename: `artifact-${index}.bin`,
            mediaType: 'application/octet-stream',
            bytesBase64: payload
        }])
        store.update(run.id, { state: 'completed', endedAt: Date.now() })
    }
    const enqueueMs = performance.now() - started
    const flushStarted = performance.now()
    await store.flush()
    const flushMs = performance.now() - flushStarted
    console.log(JSON.stringify({
        runs,
        bytesPerArtifact,
        queuedBytesAfterFlush: store.artifactStore.queuedByteCount,
        storedBytes: store.artifactStore.storedByteCount,
        enqueueMs: Number(enqueueMs.toFixed(2)),
        flushMs: Number(flushMs.toFixed(2)),
        totalMs: Number((performance.now() - started).toFixed(2))
    }, null, 2))
} finally {
    await store.flush().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
}

