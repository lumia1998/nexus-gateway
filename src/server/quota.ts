/**
 * Process-local per API-key resource accounting.
 *
 * The gateway still owns the global Session/SSE limits.  This class only
 * accounts for work admitted through the HTTP data plane, so administrator
 * operations can keep working while a client key is at its budget.
 */

export type QuotaKind = 'sessions' | 'runningRuns' | 'sse' | 'upload'

export interface QuotaLimits {
    maxSessionsPerKey: number
    maxRunningRunsPerKey: number
    maxSsePerKey: number
    maxUploadBytesPerKey: number
}

export interface QuotaUsage {
    sessions: number
    runningRuns: number
    sse: number
    uploadBytes: number
}

export interface QuotaSnapshot {
    limits: QuotaLimits
    keys: number
    usage: Record<string, QuotaUsage>
}

export class QuotaExceededError extends Error {
    readonly status = 429
    readonly retryAfterMs: number

    constructor(
        readonly quota: QuotaKind,
        readonly limit: number,
        readonly current: number,
        retryAfterMs = 1_000
    ) {
        super(`Quota exceeded: ${quota}`)
        this.name = 'QuotaExceededError'
        this.retryAfterMs = Math.max(1, Math.floor(retryAfterMs))
    }
}

interface Bucket {
    sessions: number
    runningRuns: number
    sse: number
    uploadBytes: number
}

type Reservation = () => void

const ZERO_BUCKET: Bucket = {
    sessions: 0,
    runningRuns: 0,
    sse: 0,
    uploadBytes: 0
}

/**
 * Read the canonical `config.quotas` section while retaining bounded defaults
 * for embedders that construct an in-memory config without loading the file
 * parser first.
 */
export function quotaLimitsFromConfig(config: unknown): QuotaLimits {
    const source = asRecord(config) || {}
    const nested = asRecord(source.quotas) || {}
    const pick = (name: string, fallback: number) => {
        const value = nested[name]
        return typeof value === 'number' && Number.isFinite(value) && value > 0
            ? Math.floor(value)
            : fallback
    }
    const globalSessions = positiveNumber(source.maxSessions, 64)
    const globalSse = positiveNumber(source.maxSseConnections, 128)
    const attachmentBytes = positiveNumber(source.maxAttachmentBytes, 32 * 1024 * 1024)
    return {
        maxSessionsPerKey: pick('maxSessionsPerKey', Math.max(1, Math.min(16, globalSessions))),
        maxRunningRunsPerKey: pick('maxRunningRunsPerKey', Math.max(1, Math.min(4, globalSessions))),
        maxSsePerKey: pick('maxSsePerKey', Math.max(1, Math.min(8, globalSse))),
        maxUploadBytesPerKey: pick('maxUploadBytesPerKey', attachmentBytes)
    }
}

export class QuotaManager {
    private readonly buckets = new Map<string, Bucket>()
    private readonly runOwners = new Map<string, string>()
    readonly limits: QuotaLimits

    constructor(config: unknown) {
        this.limits = quotaLimitsFromConfig(config)
    }

    reserveSession(keyId: string): Reservation {
        return this.reserveCount(keyId, 'sessions', this.limits.maxSessionsPerKey, 1_000)
    }

    reserveRunningRun(keyId: string, sessionId?: string): Reservation {
        const release = this.reserveCount(
            keyId,
            'runningRuns',
            this.limits.maxRunningRunsPerKey,
            1_000
        )
        if (sessionId) this.runOwners.set(sessionId, keyId)
        let released = false
        return () => {
            if (released) return
            released = true
            if (sessionId && this.runOwners.get(sessionId) === keyId) {
                this.runOwners.delete(sessionId)
            }
            release()
        }
    }

    /** Mark a run terminal and release its running slot, if one was tracked. */
    finishRun(sessionId: string, keyId?: string) {
        const owner = this.runOwners.get(sessionId)
        if (!owner || (keyId && owner !== keyId)) return
        this.runOwners.delete(sessionId)
        this.releaseCount(owner, 'runningRuns', 1)
    }

    reserveSse(keyId: string): Reservation {
        return this.reserveCount(keyId, 'sse', this.limits.maxSsePerKey, 1_000)
    }

    reserveUpload(keyId: string, bytes: number): Reservation {
        const amount = Math.max(0, Math.floor(bytes))
        if (!amount) return () => {}
        return this.reserveCount(
            keyId,
            'upload',
            this.limits.maxUploadBytesPerKey,
            60_000,
            amount
        )
    }

    usageFor(keyId: string): QuotaUsage {
        const bucket = this.buckets.get(keyId)
        return {
            sessions: bucket?.sessions || 0,
            runningRuns: bucket?.runningRuns || 0,
            sse: bucket?.sse || 0,
            uploadBytes: bucket?.uploadBytes || 0
        }
    }

    snapshot(): QuotaSnapshot {
        const usage: Record<string, QuotaUsage> = {}
        for (const [keyId, bucket] of this.buckets) {
            usage[keyId] = {
                sessions: bucket.sessions,
                runningRuns: bucket.runningRuns,
                sse: bucket.sse,
                uploadBytes: bucket.uploadBytes
            }
        }
        return {
            limits: { ...this.limits },
            keys: this.buckets.size,
            usage
        }
    }

    private reserveCount(
        keyId: string,
        quota: QuotaKind,
        limit: number,
        retryAfterMs: number,
        amount = 1
    ): Reservation {
        const bucket = this.bucket(keyId)
        const field = quota === 'upload' ? 'uploadBytes' : quota
        const current = bucket[field]
        if (current + amount > limit) {
            this.compact()
            throw new QuotaExceededError(quota, limit, current, retryAfterMs)
        }
        bucket[field] = current + amount
        let released = false
        return () => {
            if (released) return
            released = true
            this.releaseCount(keyId, quota, amount)
        }
    }

    private releaseCount(keyId: string, quota: QuotaKind, amount: number) {
        const bucket = this.buckets.get(keyId)
        if (!bucket) return
        const field = quota === 'upload' ? 'uploadBytes' : quota
        bucket[field] = Math.max(0, bucket[field] - amount)
        if (!bucket.sessions && !bucket.runningRuns && !bucket.sse && !bucket.uploadBytes) {
            this.buckets.delete(keyId)
        }
    }

    private bucket(keyId: string) {
        let bucket = this.buckets.get(keyId)
        if (!bucket) {
            bucket = { ...ZERO_BUCKET }
            this.buckets.set(keyId, bucket)
        }
        return bucket
    }

    private compact() {
        if (this.buckets.size <= 4096) return
        for (const [keyId, bucket] of this.buckets) {
            if (!bucket.sessions && !bucket.runningRuns && !bucket.sse && !bucket.uploadBytes) {
                this.buckets.delete(keyId)
            }
            if (this.buckets.size <= 4096) break
        }
    }
}

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined
}

function positiveNumber(value: unknown, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback
}
