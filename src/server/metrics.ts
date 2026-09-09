import { statfs } from 'node:fs/promises'
import path from 'node:path'
import type { QuotaManager } from './quota.js'
import type { RunStore } from '../run-store.js'

export interface GatewayMetricsSnapshot {
    rssBytes: number
    sessions: number
    currentSse: number
    activeSse: number
    requestCount: number
    failures: number
    quotaRejections: number
    runs: {
        active: number
        completed: number
        failed: number
        total: number
    }
    recentRuns: unknown[]
    storage?: {
        availableBytes: number
        totalBytes: number
    }
    storageMetrics?: ReturnType<RunStore['metrics']>
    quotas?: ReturnType<QuotaManager['snapshot']>
}

/** Small process-local counters used by the admin metrics endpoint. */
export class GatewayMetrics {
    private requests = 0
    private failures = 0
    private quotaRejections = 0

    requestStarted() {
        this.requests++
    }

    responseFinished(status: number, quotaRejected = false) {
        if (status >= 400) this.failures++
        if (quotaRejected) this.quotaRejections++
    }

    snapshotCounters() {
        return {
            requestCount: this.requests,
            failures: this.failures,
            quotaRejections: this.quotaRejections
        }
    }

    async snapshot(input: {
        sessions: number
        currentSse: number
        runs: {
            active: number
            completed: number
            failed: number
            total: number
        }
        recentRuns: unknown[]
        storagePath?: string
        storageMetrics?: ReturnType<RunStore['metrics']>
        quotas?: QuotaManager
    }): Promise<GatewayMetricsSnapshot> {
        const memory = process.memoryUsage()
        const counters = this.snapshotCounters()
        const storage = input.storagePath
            ? await measureStorage(input.storagePath)
            : undefined
        return {
            rssBytes: memory.rss,
            sessions: input.sessions,
            currentSse: input.currentSse,
            activeSse: input.currentSse,
            ...counters,
            runs: input.runs,
            recentRuns: input.recentRuns.slice(0, 5),
            ...(storage ? { storage } : {}),
            ...(input.storageMetrics ? { storageMetrics: input.storageMetrics } : {}),
            ...(input.quotas ? { quotas: input.quotas.snapshot() } : {})
        }
    }
}

async function measureStorage(target: string) {
    try {
        const value = await statfs(path.resolve(target))
        const blockSize = Number(value.bsize)
        return {
            availableBytes: Math.max(0, Number(value.bavail) * blockSize),
            totalBytes: Math.max(0, Number(value.blocks) * blockSize)
        }
    } catch {
        return undefined
    }
}
