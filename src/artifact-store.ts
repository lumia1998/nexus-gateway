import { createHash, randomUUID } from 'node:crypto'
import {
    chmod as fsChmod,
    lstat as fsLstat,
    mkdir as fsMkdir,
    open as fsOpen,
    readdir as fsReaddir,
    readFile as fsReadFile,
    rename as fsRename,
    rm as fsRm,
    unlink as fsUnlink,
    writeFile as fsWriteFile
} from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import type { AgentdArtifact, AgentdRunArtifactView } from './types.js'

/**
 * The value is persisted with run metadata so callers can distinguish a
 * downloadable artifact from one for which the gateway only retained
 * protocol metadata.
 */
export type ArtifactStorageStatus =
    | 'pending'
    | 'available'
    | 'metadata_only'
    | 'expired'
    | 'evicted'
    | 'failed'

export interface StoredArtifactView extends AgentdRunArtifactView {
    id: string
    storageStatus: ArtifactStorageStatus
    downloadable: boolean
    size?: number
    sha256?: string
    createdAt: number
    storedAt?: number
    expiresAt?: number
    storageError?: string
}

export interface ArtifactReadResult {
    bytes: Buffer
    filename: string
    mediaType?: string
}

export interface ArtifactStoreMetrics {
    totalPayloadBytes: number
    /** Short alias useful to metrics consumers. */
    payloadBytes: number
    queuedBytes: number
    pendingWrites: number
    retainedPayloads: number
    retainedRuns: number
    lastWriteMs: number
    writeFailures: number
    maxTotalBytes: number
    maxQueuedBytes: number
}

/**
 * A small, deliberately structural IO seam. Tests can inject failures or
 * latency without replacing the filesystem globally. Production callers can
 * leave this unset and the node fs/promises implementation is used.
 */
export interface ArtifactStoreIo {
    mkdir?: (...args: any[]) => Promise<any>
    readFile?: (...args: any[]) => Promise<any>
    writeFile?: (...args: any[]) => Promise<any>
    rename?: (...args: any[]) => Promise<any>
    chmod?: (...args: any[]) => Promise<any>
    readdir?: (...args: any[]) => Promise<any>
    lstat?: (...args: any[]) => Promise<any>
    unlink?: (...args: any[]) => Promise<any>
    rm?: (...args: any[]) => Promise<any>
    open?: (...args: any[]) => Promise<any>
}

export interface ArtifactStoreOptions {
    /** Directory owned by this store. Defaults to `<run-file>.artifacts`. */
    rootDir?: string
    /** Alias accepted for configuration adapters. */
    artifactRootDir?: string
    /** Maximum payload size for one artifact. Defaults to 12 MiB. */
    maxArtifactBytes?: number
    /** Maximum number of artifact metadata entries retained per run. */
    maxArtifactsPerRun?: number
    /** Maximum aggregate payload bytes owned by this store. */
    maxTotalBytes?: number
    /** Alias accepted for history/disk budget configuration. */
    maxDiskBytes?: number
    /** Maximum bytes awaiting asynchronous persistence. */
    maxQueuedBytes?: number
    /** Payload retention duration. Zero expires payloads immediately. */
    retentionDays?: number
    /** Clock seam used by retention and deterministic tests. */
    now?: () => number
    /** Optional IO seam used by tests. */
    io?: ArtifactStoreIo
    /** Called whenever the public metadata view changes. */
    onViewsChanged?: (runId: string, views: StoredArtifactView[]) => void
    /** Active runs are protected from retention and disk-budget eviction. */
    isRunActive?: (runId: string) => boolean
}

interface ManifestFile {
    schemaVersion: 1
    runId: string
    artifacts: ManifestArtifact[]
}

interface ManifestArtifact {
    id: string
    file: string
    view: StoredArtifactView
}

interface ArtifactEntry {
    runId: string
    id: string
    view: StoredArtifactView
    filePath?: string
    bytes?: number
    /** Last committed view retained while a replacement is pending. */
    durableView?: StoredArtifactView
}

interface PendingArtifact {
    runId: string
    id: string
    view: StoredArtifactView
    bytes: Buffer
}

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ARTIFACT_BYTES = 12 * 1024 * 1024
const DEFAULT_MAX_ARTIFACTS_PER_RUN = 32
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024
const DEFAULT_RETENTION_DAYS = 30
const MAX_FILENAME_CHARS = 180
const MAX_METADATA_CHARS = 16 * 1024
const MAX_DESCRIPTION_CHARS = 8 * 1024
const MAX_TEXT_CHARS = 2 * 1024 * 1024

/**
 * Durable payload store for run artifacts.
 *
 * The store keeps an index in memory and a small manifest per run. Payloads
 * are written into a hashed run directory with hashed file names; incoming
 * artifact ids, URLs, and filenames are never used as filesystem paths.
 */
export class ArtifactStore {
    readonly rootDir: string
    readonly maxArtifactBytes: number
    readonly maxArtifactsPerRun: number
    readonly maxTotalBytes: number
    readonly maxQueuedBytes: number
    readonly retentionDays: number

    private readonly now: () => number
    private readonly io: Required<ArtifactStoreIo>
    private readonly onViewsChanged?: (runId: string, views: StoredArtifactView[]) => void
    private readonly isRunActive: (runId: string) => boolean
    private readonly entries = new Map<string, ArtifactEntry>()
    private readonly runIds = new Set<string>()
    private readonly pending = new Map<string, Map<string, PendingArtifact>>()
    private readonly inFlight = new Map<string, PendingArtifact>()
    private readonly pendingDeletes = new Set<string>()
    private queuedBytes = 0
    private totalBytes = 0
    private activeDrain?: Promise<void>
    private initialized = false
    private lastError?: unknown
    private lastWriteMs = 0
    private writeFailures = 0

    constructor(rootDir: string, options: ArtifactStoreOptions = {}) {
        this.rootDir = path.resolve(options.rootDir || options.artifactRootDir || rootDir)
        this.maxArtifactBytes = Math.min(
            DEFAULT_MAX_ARTIFACT_BYTES,
            positiveInteger(options.maxArtifactBytes, DEFAULT_MAX_ARTIFACT_BYTES)
        )
        this.maxArtifactsPerRun = positiveInteger(
            options.maxArtifactsPerRun,
            DEFAULT_MAX_ARTIFACTS_PER_RUN
        )
        this.maxTotalBytes = nonNegativeInteger(
            options.maxTotalBytes ?? options.maxDiskBytes,
            DEFAULT_MAX_TOTAL_BYTES
        )
        this.maxQueuedBytes = nonNegativeInteger(
            options.maxQueuedBytes,
            Math.min(DEFAULT_MAX_QUEUED_BYTES, Math.max(this.maxArtifactBytes, 4 * 1024 * 1024))
        )
        this.retentionDays = nonNegativeNumber(options.retentionDays, DEFAULT_RETENTION_DAYS)
        this.now = options.now || Date.now
        this.onViewsChanged = options.onViewsChanged
        this.isRunActive = options.isRunActive || (() => false)
        this.io = {
            mkdir: options.io?.mkdir || fsMkdir,
            readFile: options.io?.readFile || fsReadFile,
            writeFile: options.io?.writeFile || fsWriteFile,
            rename: options.io?.rename || fsRename,
            chmod: options.io?.chmod || fsChmod,
            readdir: options.io?.readdir || fsReaddir,
            lstat: options.io?.lstat || fsLstat,
            unlink: options.io?.unlink || fsUnlink,
            rm: options.io?.rm || fsRm,
            open: options.io?.open || fsOpen
        }
    }

    async init() {
        if (this.initialized) return
        await this.io.mkdir(this.rootDir, { recursive: true, mode: 0o700 })
        await this.ensureDirectory(this.rootDir, false)
        await this.cleanupTemps()
        await this.loadManifests()
        this.initialized = true
        await this.prune()
    }

    /**
     * Reconcile metadata loaded from the legacy run JSON file with manifests
     * found on disk. A run JSON file remains the source of truth for metadata;
     * manifests only make payload bytes durable.
     */
    restoreRun(runId: string, views: AgentdRunArtifactView[]) {
        this.assertInitialized()
        this.runIds.add(runId)
        const incoming = views.slice(0, this.maxArtifactsPerRun).map((view, index) =>
            normalizeView(view, this.now(), `artifact-${index + 1}`)
        )
        const result: StoredArtifactView[] = []
        for (const view of incoming) {
            const key = entryKey(runId, view.id)
            const loaded = this.entries.get(key)
            if (
                loaded &&
                loaded.filePath &&
                loaded.view.storageStatus === 'available'
            ) {
                const next = {
                    ...loaded.view,
                    ...view,
                    // Newer metadata from runs.json wins over stale manifest
                    // display fields while storage facts come from the file.
                    id: view.id,
                    storageStatus: 'available' as const,
                    downloadable: true,
                    size: loaded.view.size,
                    sha256: loaded.view.sha256,
                    storedAt: loaded.view.storedAt,
                    expiresAt: loaded.view.expiresAt
                }
                loaded.view = next
                result.push(next)
            } else {
                const next = {
                    ...view,
                    storageStatus:
                        view.storageStatus === 'expired' ||
                        view.storageStatus === 'evicted' ||
                        view.storageStatus === 'failed'
                            ? view.storageStatus
                            : ('metadata_only' as const),
                    downloadable: false,
                    storageError:
                        view.storageError ||
                        (view.storageStatus === 'pending'
                            ? 'Payload was not recovered after gateway restart'
                            : undefined)
                }
                this.entries.set(key, { runId, id: view.id, view: next })
                result.push(next)
            }
        }
        // A manifest may contain entries whose JSON metadata was pruned. Keep
        // those files until the normal run-dir prune; they are never exposed.
        this.emit(runId, result)
        return structuredClone(result)
    }

    /**
     * Record protocol artifacts synchronously. Payload conversion and queue
     * insertion happen in memory; disk IO is scheduled in the background.
     */
    recordArtifacts(runId: string, artifacts: AgentdArtifact[]) {
        this.assertInitialized()
        this.runIds.add(runId)
        const existing = this.viewsForRun(runId)
        const byId = new Map(existing.map((view) => [view.id, view]))
        const accepted = artifacts.slice(0, this.maxArtifactsPerRun)
        for (let index = 0; index < accepted.length; index++) {
            const artifact = accepted[index]
            const normalized = normalizeArtifact(
                artifact,
                this.now(),
                index,
                safeId(artifact.id) || existing[index]?.id
            )
            const old = byId.get(normalized.id)
            const oldEntry = this.entries.get(entryKey(runId, normalized.id))
            const payload = payloadForArtifact(artifact, this.maxArtifactBytes)
            const baseView: StoredArtifactView = {
                ...normalized.view,
                ...(old ? { createdAt: old.createdAt, expiresAt: old.expiresAt } : {}),
                expiresAt: old?.expiresAt ?? this.now() + this.retentionDays * DAY_MS,
                storageStatus: 'metadata_only',
                downloadable: false,
                storageError: payload.error
            }
            let next = baseView
            const oldPending = this.pending.get(runId)?.get(normalized.id)
            const oldInFlight = this.inFlight.get(entryKey(runId, normalized.id))
            if (
                payload.bytes &&
                oldEntry?.view.storageStatus === 'available' &&
                oldEntry.view.sha256 === sha256(payload.bytes)
            ) {
                next = {
                    ...oldEntry.view,
                    ...baseView,
                    storageStatus: 'available',
                    downloadable: true,
                    size: oldEntry.bytes,
                    sha256: oldEntry.view.sha256,
                    storedAt: oldEntry.view.storedAt,
                    storageError: undefined
                }
            } else if (payload.bytes && oldPending?.bytes.equals(payload.bytes)) {
                next = {
                    ...oldPending.view,
                    ...baseView,
                    storageStatus: 'pending',
                    downloadable: false,
                    storageError: undefined,
                    size: payload.bytes.length
                }
                oldPending.view = next
            } else if (payload.bytes && oldInFlight?.bytes.equals(payload.bytes)) {
                next = {
                    ...oldInFlight.view,
                    ...baseView,
                    storageStatus: 'pending',
                    downloadable: false,
                    storageError: undefined,
                    size: payload.bytes.length,
                    sha256: sha256(payload.bytes)
                }
                oldInFlight.view = next
            } else if (payload.bytes) {
                // A repeated protocol id replaces a pending snapshot but keeps
                // the previous metadata until the replacement commits.
                this.removePending(runId, normalized.id)
                if (this.queuedBytes + payload.bytes.length > this.maxQueuedBytes) {
                    next = oldEntry?.view.storageStatus === 'available'
                        ? {
                            ...oldEntry.view,
                            ...baseView,
                            storageStatus: 'available',
                            downloadable: true,
                            size: oldEntry.bytes,
                            sha256: oldEntry.view.sha256,
                            storedAt: oldEntry.view.storedAt,
                            storageError: 'Artifact persistence queue budget exceeded'
                        }
                        : {
                            ...baseView,
                            storageStatus: 'metadata_only',
                            downloadable: false,
                            storageError: 'Artifact persistence queue budget exceeded'
                        }
                } else {
                    next = {
                        ...baseView,
                        storageStatus: 'pending',
                        downloadable: false,
                        storageError: undefined,
                        size: payload.bytes.length,
                        sha256: sha256(payload.bytes)
                    }
                    const pending: PendingArtifact = {
                        runId,
                        id: normalized.id,
                        view: next,
                        bytes: payload.bytes
                    }
                    this.addPending(pending)
                }
            }
            else if (oldEntry?.view.storageStatus === 'available') {
                // Metadata updates from a protocol stream can omit bytes after
                // the first snapshot. Keep the durable payload downloadable.
                next = {
                    ...oldEntry.view,
                    ...baseView,
                    storageStatus: 'available',
                    downloadable: true,
                    size: oldEntry.bytes,
                    sha256: oldEntry.view.sha256,
                    storedAt: oldEntry.view.storedAt,
                    storageError: payload.error
                }
            }
            const entry: ArtifactEntry = {
                runId,
                id: normalized.id,
                view: next,
                filePath: oldEntry?.filePath,
                bytes: oldEntry?.bytes,
                durableView:
                    oldEntry?.durableView ||
                    (oldEntry?.view.storageStatus === 'available' ? oldEntry.view : undefined)
            }
            this.entries.set(entryKey(runId, normalized.id), entry)
            byId.set(normalized.id, next)
        }
        const views = Array.from(byId.values()).slice(0, this.maxArtifactsPerRun)
        this.emit(runId, views)
        this.scheduleDrain()
        return structuredClone(views)
    }

    /** Merge display metadata from a RunStore update without dropping storage state. */
    mergeViews(runId: string, views: AgentdRunArtifactView[], notify = true) {
        this.assertInitialized()
        this.runIds.add(runId)
        const currentViews = this.viewsForRun(runId)
        const current = new Map(currentViews.map((view) => [view.id, view]))
        for (let index = 0; index < views.length && index < this.maxArtifactsPerRun; index++) {
            const raw = views[index]
            const incoming = normalizeView(
                raw.id ? raw : { ...raw, id: currentViews[index]?.id },
                this.now(),
                `artifact-${index + 1}`
            )
            const existing = current.get(incoming.id)
            const merged: StoredArtifactView = {
                ...(existing || incoming),
                ...stripUndefined(incoming as unknown as Record<string, unknown>),
                id: incoming.id,
                storageStatus: existing?.storageStatus || incoming.storageStatus,
                downloadable: existing?.downloadable ?? incoming.downloadable,
                size: existing?.size,
                sha256: existing?.sha256,
                createdAt: existing?.createdAt || incoming.createdAt,
                storedAt: existing?.storedAt,
                expiresAt: existing?.expiresAt,
                storageError: existing?.storageError
            }
            current.set(incoming.id, merged)
            const entry = this.entries.get(entryKey(runId, incoming.id))
            if (entry) entry.view = merged
            else this.entries.set(entryKey(runId, incoming.id), { runId, id: incoming.id, view: merged })
        }
        const result = Array.from(current.values()).slice(0, this.maxArtifactsPerRun)
        if (notify) this.emit(runId, result)
        return structuredClone(result)
    }

    views(runId: string) {
        this.assertInitialized()
        return structuredClone(this.viewsForRun(runId))
    }

    async readArtifact(runId: string, artifactId: string): Promise<ArtifactReadResult | undefined> {
        this.assertInitialized()
        const entry = this.entries.get(entryKey(runId, artifactId))
        if (!entry || entry.view.storageStatus !== 'available' || !entry.filePath) return undefined
        const runDir = this.runDirectory(runId)
        try {
            await this.ensureDirectory(runDir, false)
            const runReal = await this.realDirectory(runDir)
            const fileReal = await this.realPath(entry.filePath)
            if (!isContained(runReal, fileReal)) return undefined
            const stat = await this.io.lstat(entry.filePath)
            if (!stat.isFile() || stat.isSymbolicLink()) return undefined
            const bytes = await this.readRegularFile(entry.filePath, this.maxArtifactBytes)
            if (!bytes || bytes.length > this.maxArtifactBytes) return undefined
            if (entry.view.sha256 && sha256(bytes) !== entry.view.sha256) return undefined
            return {
                bytes,
                filename: entry.view.filename || entry.view.name || `artifact-${artifactId}`,
                mediaType: entry.view.mediaType
            }
        } catch (error) {
            if (isMissing(error)) return undefined
            throw error
        }
    }

    /** Queue removal of one run's own directory. Active runs are protected. */
    removeRun(runId: string) {
        this.assertInitialized()
        if (this.isRunActive(runId)) return
        this.runIds.delete(runId)
        for (const key of Array.from(this.entries.keys())) {
            if (key.startsWith(`${runId}\u0000`)) {
                const entry = this.entries.get(key)
                this.totalBytes -= entry?.bytes || 0
                this.entries.delete(key)
            }
        }
        const pending = this.pending.get(runId)
        if (pending) {
            for (const item of pending.values()) this.queuedBytes -= item.bytes.length
            this.pending.delete(runId)
        }
        this.pendingDeletes.add(runId)
        this.scheduleDrain()
    }

    async flush() {
        this.assertInitialized()
        if (this.activeDrain) await this.activeDrain
        if (this.pending.size || this.pendingDeletes.size) {
            // A previous background attempt may have failed. Keep the
            // snapshot dirty and let an explicit flush retry it.
            this.lastError = undefined
            await this.runDrain()
        }
        if (this.lastError) throw this.lastError
    }

    get queuedByteCount() {
        return this.queuedBytes
    }

    get storedByteCount() {
        return this.totalBytes
    }

    stats(): ArtifactStoreMetrics {
        const pendingWrites = Array.from(this.pending.values())
            .reduce((total, queue) => total + queue.size, this.inFlight.size + this.pendingDeletes.size)
        return {
            totalPayloadBytes: this.totalBytes,
            payloadBytes: this.totalBytes,
            queuedBytes: this.queuedBytes,
            pendingWrites,
            retainedPayloads: Array.from(this.entries.values())
                .filter((entry) => entry.view.storageStatus === 'available').length,
            retainedRuns: this.runIds.size,
            lastWriteMs: this.lastWriteMs,
            writeFailures: this.writeFailures,
            maxTotalBytes: this.maxTotalBytes,
            maxQueuedBytes: this.maxQueuedBytes
        }
    }

    private async runDrain() {
        if (this.activeDrain) return this.activeDrain
        const drain = this.drainLoop()
            .catch((error) => {
                this.lastError = error
                this.writeFailures++
                throw error
            })
            .finally(() => {
                this.activeDrain = undefined
            })
        this.activeDrain = drain
        return drain
    }

    private scheduleDrain() {
        if (!this.initialized || this.activeDrain) return
        void this.runDrain().catch((error) => {
            console.error(
                JSON.stringify({
                    level: 'error',
                    event: 'artifact_write_failed',
                    root: this.rootDir,
                    message: error instanceof Error ? error.message : String(error)
                })
            )
        })
    }

    private async drainLoop() {
        this.lastError = undefined
        while (this.pending.size || this.pendingDeletes.size) {
            const runId = this.pendingDeletes.values().next().value as string | undefined
            if (runId) {
                this.pendingDeletes.delete(runId)
                await this.deleteRunDirectory(runId)
                continue
            }
            const batchEntry = this.pending.entries().next().value as
                | [string, Map<string, PendingArtifact>]
                | undefined
            if (!batchEntry) continue
            const [batchRunId, batch] = batchEntry
            this.pending.delete(batchRunId)
            for (const item of batch.values()) {
                const key = entryKey(item.runId, item.id)
                this.inFlight.set(key, item)
                try {
                    await this.writePending(item)
                } catch (error) {
                    // Requeue the item and every item after it. The view stays
                    // pending, so retrying flush after an IO failure is safe.
                    this.requeue(item)
                    let seen = false
                    for (const rest of batch.values()) {
                        if (rest === item) {
                            seen = true
                            continue
                        }
                        if (seen) this.requeue(rest)
                    }
                    this.inFlight.delete(key)
                    throw error
                } finally {
                    this.inFlight.delete(key)
                }
            }
        }
    }

    private async writePending(item: PendingArtifact) {
        const startedAt = performance.now()
        const key = entryKey(item.runId, item.id)
        let entry = this.entries.get(key)
        if (!entry) return
        const runDir = this.runDirectory(item.runId)
        await this.io.mkdir(runDir, { recursive: true, mode: 0o700 })
        await this.ensureDirectory(runDir, false)
        const runReal = await this.realDirectory(runDir)
        if (!isContained(await this.realDirectory(this.rootDir), runReal)) {
            throw new Error('Artifact run directory escaped the artifact root')
        }
        const filePath = this.payloadPath(item.runId, item.id)
        const fileRealParent = path.dirname(filePath)
        if (!isContained(runReal, fileRealParent)) throw new Error('Invalid artifact payload path')
        const delta = item.bytes.length - (entry.bytes || 0)
        const previousView = entry.durableView
        const previousPath = entry.filePath
        const previousBytes = entry.bytes
        const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`
        try {
            await this.ensureBudget(item.runId, delta, entry)
            await this.io.writeFile(temp, item.bytes, { flag: 'wx', mode: 0o600 })
            await this.io.chmod(temp, 0o600).catch(() => undefined)
            await this.io.rename(temp, filePath)
            await this.io.chmod(filePath, 0o600).catch(() => undefined)
            // A synchronous record can replace the map entry while this write
            // is blocked on a slow filesystem. Commit against the current map
            // entry so the latest metadata receives the available status.
            const currentEntry = this.entries.get(key)
            if (!currentEntry) return
            entry = currentEntry
            const nextView: StoredArtifactView = {
                ...item.view,
                storageStatus: 'available',
                downloadable: true,
                size: item.bytes.length,
                sha256: sha256(item.bytes),
                storedAt: this.now(),
                storageError: undefined
            }
            entry.view = nextView
            entry.filePath = filePath
            entry.durableView = nextView
            this.totalBytes += delta
            entry.bytes = item.bytes.length
            await this.writeManifest(item.runId)
            this.emit(item.runId, this.viewsForRun(item.runId))
            this.lastWriteMs = Math.max(0, performance.now() - startedAt)
        } catch (error) {
            await this.io.unlink(temp).catch(() => undefined)
            if (error instanceof ArtifactBudgetError) {
                const currentEntry = this.entries.get(key)
                if (currentEntry) entry = currentEntry
                if (previousPath && previousView?.storageStatus === 'available') {
                    entry.view = previousView
                    entry.filePath = previousPath
                    entry.bytes = previousBytes
                    entry.durableView = previousView
                } else {
                    entry.view = {
                        ...item.view,
                        storageStatus: 'metadata_only',
                        downloadable: false,
                        storageError: error.message
                    }
                    entry.filePath = undefined
                    entry.bytes = undefined
                    await this.writeManifest(item.runId)
                }
                this.emit(item.runId, this.viewsForRun(item.runId))
                return
            }
            throw error
        } finally {
            this.queuedBytes -= item.bytes.length
        }
    }

    private async ensureBudget(runId: string, delta: number, replacing: ArtifactEntry) {
        if (delta <= 0 || this.totalBytes + delta <= this.maxTotalBytes) return
        const candidates = Array.from(this.entries.values())
            .filter((entry) => entry.view.storageStatus === 'available')
            .filter((entry) => entry !== replacing)
            .filter((entry) => !this.isRunActive(entry.runId))
            .sort((left, right) => left.view.createdAt - right.view.createdAt)
        for (const candidate of candidates) {
            if (this.totalBytes + delta <= this.maxTotalBytes) break
            await this.evict(candidate, 'disk_budget')
        }
        if (this.totalBytes + delta > this.maxTotalBytes) {
            throw new ArtifactBudgetError('Artifact disk budget exceeded')
        }
    }

    private async evict(entry: ArtifactEntry, reason: string) {
        if (this.isRunActive(entry.runId)) return
        if (entry.filePath) await this.safeUnlink(entry.filePath)
        this.totalBytes -= entry.bytes || 0
        entry.bytes = undefined
        entry.filePath = undefined
        entry.durableView = undefined
        entry.view = {
            ...entry.view,
            storageStatus: 'evicted',
            downloadable: false,
            storageError: reason
        }
        await this.writeManifest(entry.runId)
        this.emit(entry.runId, this.viewsForRun(entry.runId))
    }

    private async prune() {
        const cutoff = this.now() - this.retentionDays * DAY_MS
        const entries = Array.from(this.entries.values())
            .filter((entry) => entry.view.storageStatus === 'available')
            .filter((entry) => !this.isRunActive(entry.runId))
            .sort((left, right) => left.view.createdAt - right.view.createdAt)
        for (const entry of entries) {
            if (entry.view.createdAt <= cutoff) await this.expire(entry)
        }
        for (const entry of Array.from(this.entries.values()).sort(
            (left, right) => left.view.createdAt - right.view.createdAt
        )) {
            if (this.totalBytes <= this.maxTotalBytes) break
            if (entry.view.storageStatus !== 'available' || this.isRunActive(entry.runId)) continue
            await this.evict(entry, 'disk_budget')
        }
    }

    private async expire(entry: ArtifactEntry) {
        if (this.isRunActive(entry.runId)) return
        if (entry.filePath) await this.safeUnlink(entry.filePath)
        this.totalBytes -= entry.bytes || 0
        entry.bytes = undefined
        entry.filePath = undefined
        entry.durableView = undefined
        entry.view = {
            ...entry.view,
            storageStatus: 'expired',
            downloadable: false,
            storageError: 'Artifact retention period elapsed'
        }
        await this.writeManifest(entry.runId)
        this.emit(entry.runId, this.viewsForRun(entry.runId))
    }

    private async deleteRunDirectory(runId: string) {
        if (this.isRunActive(runId)) return
        const directory = this.runDirectory(runId)
        try {
            await this.ensureDirectory(directory, false)
            await this.io.rm(directory, { recursive: true, force: true })
        } catch (error) {
            if (!isMissing(error)) throw error
        }
    }

    private async writeManifest(runId: string) {
        const directory = this.runDirectory(runId)
        await this.io.mkdir(directory, { recursive: true, mode: 0o700 })
        await this.ensureDirectory(directory, false)
        const artifacts = this.viewsForRun(runId)
            .map((view) => {
                const entry = this.entries.get(entryKey(runId, view.id))
                if (!entry?.filePath || view.storageStatus !== 'available') return undefined
                return {
                    id: view.id,
                    file: path.basename(entry.filePath),
                    view: structuredClone(view)
                }
            })
            .filter((value): value is ManifestArtifact => Boolean(value))
        const manifest: ManifestFile = { schemaVersion: 1, runId, artifacts }
        const target = this.manifestPath(runId)
        const temp = `${target}.${process.pid}.${randomUUID()}.tmp`
        try {
            await this.io.writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600
            })
            await this.io.chmod(temp, 0o600).catch(() => undefined)
            await this.io.rename(temp, target)
            await this.io.chmod(target, 0o600).catch(() => undefined)
        } finally {
            await this.io.unlink(temp).catch(() => undefined)
        }
    }

    private async loadManifests() {
        let children: any[]
        try {
            children = await this.io.readdir(this.rootDir, { withFileTypes: true })
        } catch (error) {
            if (isMissing(error)) return
            throw error
        }
        for (const child of children) {
            const name = String(child.name || '')
            if (!/^[a-f0-9]{32}$/.test(name)) continue
            const directory = path.join(this.rootDir, name)
            try {
                await this.ensureDirectory(directory, false)
                const manifestPath = path.join(directory, 'manifest.json')
                const raw = await this.io.readFile(manifestPath, 'utf8')
                const parsed = JSON.parse(String(raw)) as unknown
                if (!validManifest(parsed) || hashId(parsed.runId, 32) !== name) continue
                for (const item of parsed.artifacts) {
                    if (!validManifestArtifact(item, parsed.runId)) continue
                    const filePath = path.join(directory, item.file)
                    if (path.basename(filePath) !== item.file) continue
                    const stat = await this.io.lstat(filePath)
                    if (!stat.isFile() || stat.isSymbolicLink()) continue
                    const bytes = Number(item.view.size)
                    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxArtifactBytes) continue
                    const view = {
                        ...item.view,
                        storageStatus: 'available' as const,
                        downloadable: true
                    }
                    this.entries.set(entryKey(parsed.runId, item.id), {
                        runId: parsed.runId,
                        id: item.id,
                        view,
                        filePath,
                        bytes
                    })
                    this.runIds.add(parsed.runId)
                    this.totalBytes += bytes
                }
            } catch (error) {
                if (!isMissing(error)) {
                    console.error(
                        JSON.stringify({
                            level: 'warn',
                            event: 'artifact_manifest_ignored',
                            path: directory,
                            message: error instanceof Error ? error.message : String(error)
                        })
                    )
                }
            }
        }
    }

    private async cleanupTemps() {
        let children: any[]
        try {
            children = await this.io.readdir(this.rootDir, { withFileTypes: true })
        } catch (error) {
            if (isMissing(error)) return
            throw error
        }
        for (const child of children) {
            const name = String(child.name || '')
            if (!/^[a-f0-9]{32}$/.test(name)) continue
            const directory = path.join(this.rootDir, name)
            try {
                await this.ensureDirectory(directory, false)
                const files = await this.io.readdir(directory, { withFileTypes: true })
                for (const file of files) {
                    if (String(file.name).includes('.tmp')) {
                        const target = path.join(directory, String(file.name))
                        if (path.basename(target) === String(file.name)) await this.safeUnlink(target)
                    }
                }
            } catch (error) {
                if (!isMissing(error)) continue
            }
        }
    }

    private async ensureDirectory(directory: string, create: boolean) {
        if (create) await this.io.mkdir(directory, { recursive: true, mode: 0o700 })
        const stat = await this.io.lstat(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error('Artifact storage path is not a regular directory')
        }
        await this.io.chmod(directory, 0o700).catch(() => undefined)
    }

    private async realDirectory(directory: string) {
        const target = await this.realPath(directory)
        return target
    }

    private async realPath(target: string) {
        // fs.realpath is intentionally reached through the native module only;
        // computed paths are hashed and are checked with lstat before use.
        const { realpath } = await import('node:fs/promises')
        return realpath(target)
    }

    private async readRegularFile(filePath: string, maxBytes: number): Promise<Buffer | undefined> {
        // Open/fstat/read avoids returning a directory and uses O_NOFOLLOW on
        // platforms that expose it. The lstat check above remains necessary on
        // Windows where O_NOFOLLOW is unavailable.
        const constants = (await import('node:fs')).constants
        const noFollow = constants.O_NOFOLLOW || 0
        let handle: any
        try {
            handle = await this.io.open(
                filePath,
                noFollow ? (constants.O_RDONLY | noFollow) : 'r'
            )
            const stat = typeof handle.stat === 'function' ? await handle.stat() : undefined
            if (stat && (!stat.isFile() || Number(stat.size) > maxBytes)) return undefined
            if (typeof handle.read !== 'function') {
                // Keep custom test IO shims usable while bounding the production
                // path above with FileHandle.read().
                const bytes = Buffer.from(await handle.readFile())
                return bytes.length <= maxBytes ? bytes : undefined
            }
            const buffer = Buffer.alloc(maxBytes + 1)
            let offset = 0
            while (offset < buffer.length) {
                const result = await handle.read(buffer, offset, buffer.length - offset, offset)
                const bytesRead = Number(result?.bytesRead) || 0
                if (bytesRead <= 0) break
                offset += bytesRead
            }
            return buffer.subarray(0, offset)
        } finally {
            await handle?.close?.().catch(() => undefined)
        }
    }

    private async safeUnlink(filePath: string) {
        try {
            const stat = await this.io.lstat(filePath)
            if (stat.isSymbolicLink() || !stat.isFile()) return
            await this.io.unlink(filePath)
        } catch (error) {
            if (!isMissing(error)) throw error
        }
    }

    private runDirectory(runId: string) {
        return path.join(this.rootDir, hashId(runId, 32))
    }

    private manifestPath(runId: string) {
        return path.join(this.runDirectory(runId), 'manifest.json')
    }

    private payloadPath(runId: string, artifactId: string) {
        return path.join(this.runDirectory(runId), `${hashId(artifactId, 64)}.bin`)
    }

    private viewsForRun(runId: string) {
        return Array.from(this.entries.values())
            .filter((entry) => entry.runId === runId)
            .sort((left, right) => left.view.createdAt - right.view.createdAt)
            .map((entry) => entry.view)
    }

    private addPending(item: PendingArtifact) {
        let queue = this.pending.get(item.runId)
        if (!queue) {
            queue = new Map()
            this.pending.set(item.runId, queue)
        }
        const old = queue.get(item.id)
        if (old) this.queuedBytes -= old.bytes.length
        queue.set(item.id, item)
        this.queuedBytes += item.bytes.length
    }

    private removePending(runId: string, artifactId: string) {
        const queue = this.pending.get(runId)
        const item = queue?.get(artifactId)
        if (!item || !queue) return
        this.queuedBytes -= item.bytes.length
        queue.delete(artifactId)
        if (!queue.size) this.pending.delete(runId)
    }

    private requeue(item: PendingArtifact) {
        const entry = this.entries.get(entryKey(item.runId, item.id))
        if (!entry) return
        entry.view = { ...entry.view, storageStatus: 'pending', storageError: undefined }
        this.addPending(item)
    }

    private emit(runId: string, views: StoredArtifactView[]) {
        this.onViewsChanged?.(runId, structuredClone(views))
    }

    private assertInitialized() {
        if (!this.initialized) throw new Error('ArtifactStore is not initialized')
    }
}

export class ArtifactBudgetError extends Error {}

export function artifactStorePathForRunStore(runStorePath: string) {
    return `${path.resolve(runStorePath)}.artifacts`
}

function normalizeArtifact(
    artifact: AgentdArtifact,
    now: number,
    index: number,
    forcedId?: string
) {
    const id = safeId(artifact.id) || forcedId || randomUUID()
    const filename = safeFilename(
        artifact.filename || artifact.name || `artifact-${index + 1}`
    ) || `artifact-${id.slice(0, 12)}`
    const name = clipString(artifact.name || filename, MAX_FILENAME_CHARS)
    const mediaType = safeMediaType(artifact.mediaType)
    const metadata = safeMetadata(artifact.metadata)
    const expiresAt = now + DEFAULT_RETENTION_DAYS * DAY_MS
    const view: StoredArtifactView = {
        id,
        name,
        description: clipString(artifact.description, MAX_DESCRIPTION_CHARS),
        url: safeUrl(artifact.url),
        filename,
        mediaType,
        metadata,
        storageStatus: 'metadata_only',
        downloadable: false,
        createdAt: now,
        expiresAt
    }
    return { id, view }
}

function normalizeView(value: AgentdRunArtifactView, now: number, fallback: string): StoredArtifactView {
    const id = safeId(value.id) || randomUUID()
    const filename = safeFilename(value.filename || value.name || fallback) || fallback
    const incoming = value as StoredArtifactView
    return {
        ...structuredClone(value),
        id,
        name: clipString(value.name || filename, MAX_FILENAME_CHARS),
        description: clipString(value.description, MAX_DESCRIPTION_CHARS),
        url: safeUrl(value.url),
        filename,
        mediaType: safeMediaType(value.mediaType),
        metadata: safeMetadata(value.metadata),
        storageStatus: incoming.storageStatus || 'metadata_only',
        downloadable: incoming.downloadable === true && incoming.storageStatus === 'available',
        createdAt: Number.isFinite(incoming.createdAt) ? incoming.createdAt : now,
        expiresAt: Number.isFinite(incoming.expiresAt)
            ? incoming.expiresAt
            : now + DEFAULT_RETENTION_DAYS * DAY_MS
    }
}

function payloadForArtifact(artifact: AgentdArtifact, maxBytes: number) {
    try {
        if (typeof artifact.bytesBase64 === 'string') {
            const normalized = artifact.bytesBase64.replace(/\s+/g, '')
            if (
                !normalized ||
                normalized.length % 4 === 1 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
            ) {
                return { error: 'Invalid base64 artifact payload' }
            }
            if (normalized.length > Math.ceil(maxBytes * 4 / 3) + 8) {
                return { error: `Artifact exceeds the ${maxBytes} byte limit` }
            }
            const bytes = Buffer.from(normalized, 'base64')
            const canonical = bytes.toString('base64').replace(/=+$/, '')
            if (canonical !== normalized.replace(/=+$/, '')) {
                return { error: 'Invalid base64 artifact payload' }
            }
            if (bytes.length > maxBytes) return { error: `Artifact exceeds the ${maxBytes} byte limit` }
            return { bytes }
        }
        if (typeof artifact.text === 'string') {
            if (artifact.text.length > MAX_TEXT_CHARS) {
                return { error: 'Text artifact exceeds the text snapshot limit' }
            }
            const bytes = Buffer.from(artifact.text, 'utf8')
            return bytes.length <= maxBytes
                ? { bytes }
                : { error: `Artifact exceeds the ${maxBytes} byte limit` }
        }
        if (artifact.data !== undefined) {
            const data = artifact.data as any
            let bytes: Buffer
            if (Buffer.isBuffer(data)) bytes = Buffer.from(data)
            else if (data instanceof Uint8Array) bytes = Buffer.from(data)
            else if (data instanceof ArrayBuffer) bytes = Buffer.from(data)
            else if (
                data &&
                typeof data === 'object' &&
                data.type === 'Buffer' &&
                Array.isArray(data.data)
            ) {
                bytes = Buffer.from(data.data)
            } else if (typeof data === 'string') bytes = Buffer.from(data, 'utf8')
            else {
                const serialized = JSON.stringify(data)
                if (serialized === undefined) return { error: 'Artifact data is not serializable' }
                bytes = Buffer.from(serialized, 'utf8')
            }
            if (bytes.length > maxBytes) return { error: `Artifact exceeds the ${maxBytes} byte limit` }
            return { bytes }
        }
        return {}
    } catch (error) {
        return { error: `Artifact payload could not be serialized: ${errorMessage(error)}` }
    }
}

function validManifest(value: unknown): value is ManifestFile {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const candidate = value as ManifestFile
    return candidate.schemaVersion === 1 && typeof candidate.runId === 'string' && Array.isArray(candidate.artifacts)
}

function validManifestArtifact(value: unknown, runId: string): value is ManifestArtifact {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const candidate = value as ManifestArtifact
    return (
        typeof candidate.id === 'string' &&
        candidate.id.length > 0 &&
        typeof candidate.file === 'string' &&
        /^[a-f0-9]{64}\.bin$/.test(candidate.file) &&
        Boolean(candidate.view) &&
        candidate.view.id === candidate.id &&
        hashId(candidate.id, 64) === candidate.file.slice(0, 64) &&
        (candidate.view.storageStatus === 'available' || candidate.view.storageStatus === ('stored' as any)) &&
        (!candidate.view.url || typeof candidate.view.url === 'string') &&
        Boolean(runId)
    )
}

function entryKey(runId: string, artifactId: string) {
    return `${runId}\u0000${artifactId}`
}

function hashId(value: string, length: number) {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length)
}

function sha256(bytes: Buffer) {
    return createHash('sha256').update(bytes).digest('hex')
}

function safeId(value: unknown) {
    const id = typeof value === 'string' ? value.trim() : ''
    return id && id.length <= 256 ? id : undefined
}

function safeFilename(value: unknown) {
    const raw = typeof value === 'string' ? value : ''
    const basename = raw.split(/[\\/]/).pop() || raw
    return basename
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/^\.+$/, '_')
        .trim()
        .slice(0, MAX_FILENAME_CHARS)
}

function safeMediaType(value: unknown) {
    const mediaType = typeof value === 'string' ? value.trim() : ''
    return /^[\w!#$&^_.+\-/]{1,180}$/.test(mediaType) ? mediaType : undefined
}

function safeUrl(value: unknown) {
    const url = typeof value === 'string' ? value.trim() : ''
    return url.length <= 4 * 1024 && /^(?:https?|file):/i.test(url) ? url : undefined
}

function safeMetadata(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    try {
        const serialized = JSON.stringify(value)
        if (!serialized || serialized.length > MAX_METADATA_CHARS) {
            return { storageWarning: 'Artifact metadata omitted because it exceeded the metadata limit' }
        }
        return structuredClone(value) as Record<string, unknown>
    } catch {
        return { storageWarning: 'Artifact metadata omitted because it was not serializable' }
    }
}

function clipString(value: unknown, max: number) {
    if (typeof value !== 'string' || !value) return undefined
    return value.length > max ? `${value.slice(0, max)}…` : value
}

function stripUndefined<T extends Record<string, unknown>>(value: T) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function positiveInteger(value: number | undefined, fallback: number) {
    return Number.isFinite(value) && Number(value) > 0 ? Math.floor(Number(value)) : fallback
}

function nonNegativeInteger(value: number | undefined, fallback: number) {
    return Number.isFinite(value) && Number(value) >= 0 ? Math.floor(Number(value)) : fallback
}

function nonNegativeNumber(value: number | undefined, fallback: number) {
    return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback
}

function isContained(root: string, target: string) {
    const relative = path.relative(root, target)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function isMissing(error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
