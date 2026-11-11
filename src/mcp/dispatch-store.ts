import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface Entry {
    owner: string
    requestId: string
    fingerprint: string
    createdAt: number
    state: 'reserved' | 'accepted' | 'failed'
    taskId?: string
    sessionId?: string
    error?: string
}

export interface DispatchReceipt { task_id: string; session_id: string; request_id: string; reused: boolean }

/** A persisted reservation precedes execution. An uncertain restart is never permission to replay. */
export class McpDispatchStore {
    private entries = new Map<string, Entry>()
    private active = new Map<string, Promise<DispatchReceipt>>()
    private loaded?: Promise<void>
    private writes = Promise.resolve()
    constructor(private readonly file: string, private readonly now = Date.now) {}

    async once(owner: string, requestId: string, input: unknown, start: () => Promise<{ taskId: string; sessionId: string }>): Promise<DispatchReceipt> {
        await (this.loaded ??= this.load())
        const key = JSON.stringify([owner, requestId])
        const fingerprint = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
        const cutoff = this.now() - 24 * 60 * 60_000
        for (const [id, entry] of this.entries) if (entry.createdAt < cutoff && !this.active.has(id)) this.entries.delete(id)
        const existing = this.entries.get(key)
        if (existing) {
            if (existing.fingerprint !== fingerprint) throw new Error('request_id is already bound to different task arguments')
            const pending = this.active.get(key)
            if (pending) return { ...await pending, reused: true }
            if (existing.state === 'accepted') return this.receipt(existing, true)
            if (existing.state === 'failed') throw new Error(`Previous dispatch failed: ${existing.error}. Inspect the failure before using a new request_id.`)
            throw new Error('Dispatch outcome is uncertain after a restart or persistence failure. Do not automatically replay this task; inspect gateway runs before submitting a new request_id.')
        }
        if (this.entries.size >= 2048) throw new Error('MCP dispatch receipt capacity reached; receipts expire after 24 hours')
        const entry: Entry = { owner, requestId, fingerprint, createdAt: this.now(), state: 'reserved' }
        this.entries.set(key, entry)
        const execute = async () => {
            try { await this.persist() } catch (error) { this.entries.delete(key); throw error }
            let result: { taskId: string; sessionId: string }
            try { result = await start() } catch (error) {
                entry.state = 'failed'
                entry.error = error instanceof Error ? error.message.slice(0, 500) : 'Dispatch failed'
                await this.persist()
                throw error
            }
            Object.assign(entry, result, { state: 'accepted' })
            try { await this.persist() } catch {
                throw new Error(`Task accepted (${result.taskId}) but its receipt could not be persisted. Query this task_id; do not submit again.`)
            }
            return this.receipt(entry, false)
        }
        const promise = execute()
        this.active.set(key, promise)
        try { return await promise } finally { this.active.delete(key) }
    }

    private receipt(entry: Entry, reused: boolean): DispatchReceipt {
        return { task_id: entry.taskId!, session_id: entry.sessionId!, request_id: entry.requestId, reused }
    }

    private async load() {
        try {
            const parsed = JSON.parse(await readFile(this.file, 'utf8'))
            if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > 2048) throw new Error('Invalid MCP dispatch receipt file')
            for (const entry of parsed.entries) {
                if (typeof entry.owner !== 'string' || typeof entry.requestId !== 'string' || typeof entry.fingerprint !== 'string' || !Number.isFinite(entry.createdAt) ||
                    !['reserved', 'accepted', 'failed'].includes(entry.state) || entry.state === 'accepted' && (typeof entry.taskId !== 'string' || typeof entry.sessionId !== 'string')) throw new Error('Invalid MCP dispatch receipt entry')
                this.entries.set(JSON.stringify([entry.owner, entry.requestId]), entry)
            }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }

    private persist() {
        const json = JSON.stringify({ version: 1, entries: [...this.entries.values()] })
        const write = async () => {
            await mkdir(path.dirname(this.file), { recursive: true })
            const temporary = `${this.file}.${randomUUID()}.tmp`
            try { await writeFile(temporary, json, { mode: 0o600 }); await rename(temporary, this.file) }
            finally { await unlink(temporary).catch(() => undefined) }
        }
        const next = this.writes.then(write, write)
        this.writes = next.catch(() => undefined)
        return next
    }
}

function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
    return value
}
