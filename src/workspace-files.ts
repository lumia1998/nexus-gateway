import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import {
    lstat,
    mkdir,
    open as openFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AgentdFileEntryView, AgentdFileRootView } from './types.js'

export class WorkspaceFileError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

export class WorkspaceFiles {
    constructor(
        private readonly configuredRoots: () => string[],
        private readonly maxWriteBytes: number
    ) {}

    async roots(): Promise<AgentdFileRootView[]> {
        const values = await Promise.all(
            this.configuredRoots().map(async (configured) => {
                const rootPath = await realpath(configured)
                return {
                    id: rootId(rootPath),
                    name: path.basename(rootPath) || rootPath,
                    path: rootPath
                }
            })
        )
        return Array.from(new Map(values.map((root) => [root.id, root])).values())
    }

    async adminRoot(id: string) {
        const root = (await this.roots()).find((item) => item.id === id)
        if (!root) throw new WorkspaceFileError(404, 'Workspace root not found')
        return root.path
    }

    async sessionRoot(workspace?: string) {
        if (!workspace) throw new WorkspaceFileError(409, 'Session has no local workspace')
        const candidate = await realpath(workspace)
        const roots = await this.roots()
        if (!roots.some((root) => isWithin(root.path, candidate))) {
            throw new WorkspaceFileError(403, 'Session workspace is outside the configured roots')
        }
        return candidate
    }

    async list(root: string, relative = '') {
        const directory = await this.existing(root, relative, true)
        const details = await stat(directory)
        if (!details.isDirectory()) throw new WorkspaceFileError(400, 'Path is not a directory')
        const entries = await readdir(directory, { withFileTypes: true })
        const result = await Promise.all(
            entries.map(async (entry): Promise<AgentdFileEntryView> => {
                const filePath = path.join(directory, entry.name)
                const info = await lstat(filePath)
                const type = entry.isDirectory()
                    ? 'directory'
                    : entry.isFile()
                      ? 'file'
                      : entry.isSymbolicLink()
                        ? 'symlink'
                        : 'other'
                return {
                    name: entry.name,
                    path: joinRelative(relative, entry.name),
                    type,
                    ...(type === 'file' ? { size: info.size } : {}),
                    modifiedAt: info.mtimeMs
                }
            })
        )
        result.sort((left, right) => {
            if (left.type === 'directory' && right.type !== 'directory') return -1
            if (right.type === 'directory' && left.type !== 'directory') return 1
            return left.name.localeCompare(right.name)
        })
        return { path: normalizeRelative(relative, true), entries: result }
    }

    async open(root: string, relative: string) {
        const rootPath = await realpath(root)
        const normalized = normalizeRelative(relative, false)
        const candidate = path.join(rootPath, normalized)
        let before: string
        try {
            before = await realpath(candidate)
        } catch (error) {
            throwPathError(error)
        }
        if (!isWithin(rootPath, before)) {
            throw new WorkspaceFileError(403, 'Path leaves the workspace root')
        }
        let handle: FileHandle
        try {
            handle = await openFile(candidate, 'r')
        } catch (error) {
            throwPathError(error)
        }
        try {
            const opened = await handle.stat({ bigint: true })
            if (!opened.isFile()) throw new WorkspaceFileError(400, 'Path is not a file')
            let after: string
            try {
                after = await realpath(candidate)
            } catch (error) {
                if (isMissingPathError(error)) {
                    throw new WorkspaceFileError(409, 'File changed while it was being opened')
                }
                throw error
            }
            if (!isWithin(rootPath, after)) {
                throw new WorkspaceFileError(403, 'Path leaves the workspace root')
            }
            const current = await stat(after, { bigint: true })
            if (opened.dev !== current.dev || opened.ino !== current.ino) {
                throw new WorkspaceFileError(409, 'File changed while it was being opened')
            }
            return {
                handle,
                filePath: after,
                name: path.basename(normalized),
                size: Number(opened.size)
            }
        } catch (error) {
            await handle.close()
            throw error
        }
    }

    async publishable(root: string, input: string) {
        const relative = path.isAbsolute(input) ? path.relative(root, input) : input
        return this.open(root, relative)
    }

    async write(root: string, relative: string, input: Readable, declaredSize?: number) {
        if (declaredSize !== undefined && declaredSize > this.maxWriteBytes) {
            throw new WorkspaceFileError(413, 'Upload exceeds the file size limit')
        }
        const target = await this.writable(root, relative)
        const temporary = path.join(path.dirname(target), `.nexus-upload-${randomUUID()}`)
        let size = 0
        const meter = new Transform({
            transform: (chunk: Buffer, _encoding, callback) => {
                size += chunk.length
                if (size > this.maxWriteBytes) {
                    callback(new WorkspaceFileError(413, 'Upload exceeds the file size limit'))
                    return
                }
                callback(null, chunk)
            }
        })
        try {
            await pipeline(input, meter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
            await rename(temporary, target)
            return { path: normalizeRelative(relative, false), size }
        } catch (error) {
            await rm(temporary, { force: true }).catch(() => undefined)
            throw error
        }
    }

    async createDirectory(root: string, relative: string) {
        const target = await this.writable(root, relative)
        await mkdir(target)
        return { path: normalizeRelative(relative, false) }
    }

    async move(root: string, source: string, destination: string) {
        const sourcePath = await this.existing(root, source, false, false)
        const destinationPath = await this.writable(root, destination)
        try {
            await lstat(destinationPath)
            throw new WorkspaceFileError(409, 'Destination already exists')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rename(sourcePath, destinationPath)
        return {
            path: normalizeRelative(source, false),
            destination: normalizeRelative(destination, false)
        }
    }

    async remove(root: string, relative: string) {
        const target = await this.existing(root, relative, false, false)
        await rm(target, { recursive: true, force: false })
        return { path: normalizeRelative(relative, false) }
    }

    private async existing(root: string, relative: string, allowEmpty: boolean, follow = true) {
        const rootPath = await realpath(root)
        const normalized = normalizeRelative(relative, allowEmpty)
        const candidate = path.join(rootPath, normalized)
        let resolved: string
        try {
            resolved = follow ? await realpath(candidate) : await resolveParent(candidate)
        } catch (error) {
            throwPathError(error)
        }
        if (!isWithin(rootPath, resolved)) throw new WorkspaceFileError(403, 'Path leaves the workspace root')
        return resolved
    }

    private async writable(root: string, relative: string) {
        const rootPath = await realpath(root)
        const normalized = normalizeRelative(relative, false)
        const candidate = path.join(rootPath, normalized)
        let parent: string
        try {
            parent = await realpath(path.dirname(candidate))
        } catch (error) {
            throwPathError(error)
        }
        if (!isWithin(rootPath, parent)) throw new WorkspaceFileError(403, 'Path leaves the workspace root')
        return path.join(parent, path.basename(candidate))
    }
}

export function workspaceRootId(root: string) {
    return rootId(path.resolve(root))
}

function normalizeRelative(value: string, allowEmpty: boolean) {
    const input = String(value || '').replace(/[\\/]+/g, path.sep)
    if (input.includes('\0') || path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
        throw new WorkspaceFileError(400, 'Path must be relative to the workspace root')
    }
    const normalized = path.normalize(input || '.')
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw new WorkspaceFileError(403, 'Path leaves the workspace root')
    }
    if (normalized === '.') {
        if (allowEmpty) return ''
        throw new WorkspaceFileError(400, 'A file or directory path is required')
    }
    return normalized
}

async function resolveParent(candidate: string) {
    const parent = await realpath(path.dirname(candidate))
    const target = path.join(parent, path.basename(candidate))
    await lstat(target)
    return target
}

function rootId(value: string) {
    return createHash('sha256').update(path.resolve(value)).digest('hex').slice(0, 24)
}

function isWithin(root: string, candidate: string) {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function joinRelative(parent: string, name: string) {
    const normalized = normalizeRelative(parent, true)
    return normalized ? path.join(normalized, name) : name
}

function isMissingPathError(error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
}

function throwPathError(error: unknown): never {
    if (isMissingPathError(error)) {
        throw new WorkspaceFileError(404, 'File or directory not found')
    }
    throw error
}
