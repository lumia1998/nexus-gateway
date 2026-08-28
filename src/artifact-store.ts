import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, mkdir, open, readdir, rename, rm, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AgentdPublishedFile } from './types.js'

interface StoredArtifact extends AgentdPublishedFile {
    filePath: string
    handle?: FileHandle
}

export class ArtifactStoreError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

export class GatewayArtifactStore {
    private readonly byCacheKey = new Map<string, StoredArtifact>()
    private cleanupTimer?: NodeJS.Timeout
    private capacityQueue = Promise.resolve()
    private activePublishes = 0
    private reservedBytes = 0
    private reservedFiles = 0

    constructor(
        private readonly directory: string,
        private readonly ttlMs: number,
        private readonly maxBytes: number,
        private readonly maxStorageBytes = Math.max(maxBytes, 4 * 1024 * 1024 * 1024),
        private readonly maxFiles = 4096,
        private readonly maxConcurrentPublishes = 4
    ) {}

    startCleanup(intervalMs = Math.min(this.ttlMs, 60 * 60 * 1000)) {
        if (this.cleanupTimer) return
        void this.cleanup().catch((error) => {
            console.error(`[nexus-agentd] initial artifact cleanup failed: ${errorMessage(error)}`)
        })
        this.cleanupTimer = setInterval(() => {
            void this.cleanup().catch((error) => {
                console.error(`[nexus-agentd] artifact cleanup failed: ${errorMessage(error)}`)
            })
        }, Math.max(60_000, intervalMs))
        this.cleanupTimer.unref?.()
    }

    stopCleanup() {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer)
        this.cleanupTimer = undefined
    }

    async publishFile(filePath: string, preferredName?: string, mediaType?: string) {
        const handle = await open(filePath, 'r')
        try {
            return await this.publishHandle(
                handle,
                preferredName || path.basename(filePath),
                mediaType
            )
        } finally {
            await handle.close()
        }
    }

    async publishHandle(handle: FileHandle, preferredName: string, mediaType?: string) {
        const details = await handle.stat()
        if (!details.isFile()) throw new ArtifactStoreError(400, 'Only regular files can be published')
        if (details.size > this.maxBytes) throw new ArtifactStoreError(413, 'File exceeds the publish size limit')
        return this.publishStream(
            handle.createReadStream({ autoClose: false }),
            preferredName,
            mediaType,
            details.size
        )
    }

    async publishBytes(
        bytes: Uint8Array,
        preferredName: string,
        mediaType?: string,
        cacheKey?: string
    ) {
        if (bytes.byteLength > this.maxBytes) {
            throw new ArtifactStoreError(413, 'File exceeds the publish size limit')
        }
        const { Readable } = await import('node:stream')
        return this.publishStream(
            Readable.from([bytes]),
            preferredName,
            mediaType,
            bytes.byteLength,
            cacheKey
        )
    }

    async publishStream(
        input: Readable,
        preferredName: string,
        mediaType?: string,
        declaredSize?: number,
        cacheKey?: string
    ): Promise<AgentdPublishedFile> {
        if (declaredSize !== undefined && declaredSize > this.maxBytes) {
            throw new ArtifactStoreError(413, 'File exceeds the publish size limit')
        }
        await this.ensureDirectory()
        const releaseCapacity = await this.reserveCapacity(declaredSize ?? this.maxBytes)
        const name = safeFilename(preferredName)
        const temporary = path.join(this.directory, `.upload-${randomUUID()}`)
        const hash = createHash('sha256')
        let size = 0
        const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                size += chunk.length
                if (size > this.maxBytes) {
                    callback(new ArtifactStoreError(413, 'File exceeds the publish size limit'))
                    return
                }
                hash.update(chunk)
                callback(null, chunk)
            }
        })
        try {
            await pipeline(input, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
            const sha256 = hash.digest('hex')
            const cacheId = cacheKey ? `${cacheKey}\0${sha256}` : undefined
            const existing = cacheId ? this.byCacheKey.get(cacheId) : undefined
            if (existing && (await this.isAvailable(existing))) {
                await rm(temporary, { force: true })
                return publicView(existing)
            }
            const id = randomBytes(32).toString('hex')
            const expiresAt = Date.now() + this.ttlMs
            const filePath = path.join(this.directory, storedFilename(id, expiresAt, name))
            await rename(temporary, filePath)
            const stored: StoredArtifact = {
                id,
                name,
                url: artifactUrl(id, expiresAt, name),
                size,
                mediaType: mediaType || mediaTypeForName(name),
                sha256,
                expiresAt,
                filePath
            }
            if (cacheId) this.byCacheKey.set(cacheId, stored)
            return publicView(stored)
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined)
            throw error
        } finally {
            releaseCapacity()
        }
    }

    async open(id: string, expiresInput: string, requestedName: string): Promise<StoredArtifact> {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new ArtifactStoreError(404, 'Artifact not found')
        const expiresAt = Number(expiresInput)
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
            throw new ArtifactStoreError(404, 'Artifact not found')
        }
        const name = safeFilename(requestedName)
        if (name !== requestedName) throw new ArtifactStoreError(404, 'Artifact not found')
        const filePath = path.join(this.directory, storedFilename(id, expiresAt, name))
        let handle: FileHandle
        try {
            handle = await open(filePath, 'r')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new ArtifactStoreError(404, 'Artifact not found')
            }
            throw error
        }
        let details
        try {
            details = await handle.stat()
        } catch (error) {
            await handle.close()
            throw error
        }
        if (!details.isFile()) {
            await handle.close()
            throw new ArtifactStoreError(404, 'Artifact not found')
        }
        return {
            id,
            name,
            url: artifactUrl(id, expiresAt, name),
            size: details.size,
            mediaType: mediaTypeForName(name),
            sha256: '',
            expiresAt,
            filePath,
            handle
        }
    }

    async cleanup() {
        await this.ensureDirectory()
        const now = Date.now()
        const names = await readdir(this.directory)
        await Promise.all(
            names.map(async (name) => {
                const filePath = path.join(this.directory, name)
                try {
                    const parsed = parseStoredFilename(name)
                    if (parsed?.expiresAt !== undefined && parsed.expiresAt <= now) {
                        await rm(filePath, { force: true })
                        return
                    }
                    if (name.startsWith('.upload-')) {
                        const details = await stat(filePath)
                        if (details.mtimeMs + Math.max(this.ttlMs, 60 * 60 * 1000) <= now) {
                            await rm(filePath, { force: true })
                        }
                    }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                }
            })
        )
        for (const [cacheId, artifact] of this.byCacheKey) {
            if (artifact.expiresAt <= now) this.byCacheKey.delete(cacheId)
        }
    }

    private async ensureDirectory() {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        if (process.platform !== 'win32') await chmod(this.directory, 0o700)
    }

    private async isAvailable(artifact: StoredArtifact) {
        if (artifact.expiresAt <= Date.now()) return false
        try {
            const details = await stat(artifact.filePath)
            return details.isFile()
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw error
        }
    }

    private async reserveCapacity(expectedBytes: number) {
        let unlock!: () => void
        const previous = this.capacityQueue
        this.capacityQueue = new Promise<void>((resolve) => {
            unlock = resolve
        })
        await previous
        try {
            if (this.activePublishes >= this.maxConcurrentPublishes) {
                throw new ArtifactStoreError(429, 'Artifact publish concurrency limit reached')
            }
            const usage = await this.storageUsage()
            if (usage.bytes + this.reservedBytes + expectedBytes > this.maxStorageBytes) {
                throw new ArtifactStoreError(507, 'Artifact storage capacity reached')
            }
            if (usage.files + this.reservedFiles + 1 > this.maxFiles) {
                throw new ArtifactStoreError(507, 'Artifact file count limit reached')
            }
            this.activePublishes += 1
            this.reservedBytes += expectedBytes
            this.reservedFiles += 1
        } finally {
            unlock()
        }
        let released = false
        return () => {
            if (released) return
            released = true
            this.activePublishes = Math.max(0, this.activePublishes - 1)
            this.reservedBytes = Math.max(0, this.reservedBytes - expectedBytes)
            this.reservedFiles = Math.max(0, this.reservedFiles - 1)
        }
    }

    private async storageUsage() {
        await this.ensureDirectory()
        const now = Date.now()
        let bytes = 0
        let files = 0
        for (const name of await readdir(this.directory)) {
            const parsed = parseStoredFilename(name)
            if (parsed?.expiresAt !== undefined && parsed.expiresAt <= now) {
                await rm(path.join(this.directory, name), { force: true })
                continue
            }
            try {
                const details = await stat(path.join(this.directory, name))
                if (!details.isFile()) continue
                bytes += details.size
                files += 1
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
        }
        return { bytes, files }
    }
}

export function contentDisposition(name: string) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function mediaTypeForName(name: string) {
    const types: Record<string, string> = {
        '.avif': 'image/avif',
        '.csv': 'text/csv; charset=utf-8',
        '.gif': 'image/gif',
        '.html': 'text/html; charset=utf-8',
        '.jpeg': 'image/jpeg',
        '.jpg': 'image/jpeg',
        '.json': 'application/json; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.txt': 'text/plain; charset=utf-8',
        '.wav': 'audio/wav',
        '.webm': 'video/webm',
        '.webp': 'image/webp',
        '.zip': 'application/zip'
    }
    return types[path.extname(name).toLowerCase()] || 'application/octet-stream'
}

function artifactUrl(id: string, expiresAt: number, name: string) {
    return `/v1/artifacts/${id}/${expiresAt}/${encodeURIComponent(name)}`
}

function storedFilename(id: string, expiresAt: number, name: string) {
    return `${id}-${expiresAt}-${name}`
}

function parseStoredFilename(value: string) {
    const match = /^([a-f0-9]{64})-(\d+)-(.+)$/.exec(value)
    if (!match) return undefined
    const expiresAt = Number(match[2])
    if (!Number.isSafeInteger(expiresAt)) return undefined
    return { id: match[1], expiresAt, name: match[3] }
}

function safeFilename(value: string) {
    const basename = path.basename(String(value || 'artifact').replace(/\\/g, '/'))
    const safe = basename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 180)
    return safe || 'artifact'
}

function publicView(value: StoredArtifact): AgentdPublishedFile {
    const { filePath: _filePath, handle: _handle, ...result } = value
    return result
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
