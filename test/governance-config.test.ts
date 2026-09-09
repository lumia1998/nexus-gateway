import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadAgentdConfig } from '../src/config.js'

test('quota and storage defaults are bounded and malformed configuration fails closed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-governance-'))
    const file = path.join(directory, 'config.json')
    const base = { initialized: false, workspaceRoots: [directory], agents: {}, maxSessions: 2, maxSseConnections: 3 }
    try {
        await writeFile(file, JSON.stringify(base))
        const loaded = await loadAgentdConfig(file)
        assert.deepEqual(loaded.quotas, { maxSessionsPerKey: 2, maxRunningRunsPerKey: 2, maxSsePerKey: 3, maxUploadBytesPerKey: 32 * 1024 * 1024 })
        assert.deepEqual(loaded.history, { maxRuns: 1000, retentionDays: 30, maxBytes: 64 * 1024 * 1024 })
        assert.equal(loaded.artifacts?.maxArtifactBytes, 12 * 1024 * 1024)
        for (const invalid of [
            { quotas: [] }, { quotas: { maxSessionsPerKey: 0 } }, { quotas: { maxRunningRunsPerKey: 1.5 } },
            { quotas: { maxUploadBytesPerKey: '1024' } }, { history: { maxRuns: -1 } },
            { history: { retentionDays: 0 } }, { history: { maxBytes: 1 } },
            { artifacts: { maxArtifactBytes: 13 * 1024 * 1024 } }, { artifacts: { maxQueuedBytes: -1 } }
        ]) {
            await writeFile(file, JSON.stringify({ ...base, ...invalid }))
            await assert.rejects(loadAgentdConfig(file), /quotas|history|artifacts/)
        }
        await writeFile(file, JSON.stringify({ ...base, history: { maxRuns: 17, retentionDays: 2, maxBytes: 4096 }, artifacts: { maxBytes: 8192, maxQueuedBytes: 4096 } }))
        const custom = await loadAgentdConfig(file)
        assert.equal(custom.history?.maxRuns, 17)
        assert.equal(custom.history?.maxBytes, 4096)
        assert.equal(custom.artifacts?.maxBytes, 8192)
    } finally { await rm(directory, { recursive: true, force: true }) }
})
