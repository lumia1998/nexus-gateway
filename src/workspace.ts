import { open, realpath } from 'node:fs/promises'
import path from 'node:path'

export class WorkspacePolicy {
    private constructor(private readonly roots: string[]) {}

    static async create(configuredRoots: string[]) {
        const roots = await Promise.all(
            configuredRoots.map(async (root) => normalize(await realpath(root)))
        )
        return new WorkspacePolicy(Array.from(new Set(roots)))
    }

    async resolve(input: string) {
        if (!input?.trim()) throw new Error('workspace is required')
        const candidate = normalize(await realpath(input))
        const allowed = this.roots.some((root) => isWithin(root, candidate))
        if (!allowed) throw new Error(`workspace is outside the configured allowlist: ${input}`)
        return candidate
    }

    listRoots() {
        return [...this.roots]
    }
}

export function isWithin(root: string, candidate: string) {
    const relative = path.relative(root, candidate)
    return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative))
    )
}

export type ContainedReadFailure = 'outside' | 'swapped' | 'not-a-file' | 'too-large'

/**
 * Reported as a kind rather than a finished message because each caller owns a
 * different error contract: workspace publish maps it to an HTTP status, while a
 * MEDIA marker maps it to a terminal_output event.
 */
export class ContainedReadError extends Error {
    constructor(readonly failure: ContainedReadFailure, message: string) {
        super(message)
        this.name = 'ContainedReadError'
    }
}

export interface ContainedFile {
    root: string
    path: string
    relative: string
    filename: string
    bytes: Buffer
    size: number
}

/**
 * Reads a file that must resolve inside one of `roots`.
 *
 * `roots` must already be realpath'd absolute paths; `WorkspacePolicy.listRoots()`
 * satisfies this. A caller that passes an unresolved root fails closed, because
 * containment is checked against a realpath'd target. `requested` may be absolute
 * (an agent-declared path) or relative to `roots[0]` (a client-supplied path).
 */
export async function readContainedFile(
    roots: readonly string[],
    requested: string,
    options: { maxBytes: number }
): Promise<ContainedFile> {
    if (!roots.length) {
        throw new ContainedReadError('outside', 'no workspace root is configured')
    }
    const unresolved = path.resolve(roots[0], requested)
    const target = await realpath(unresolved)
    const root = roots.find((candidate) => isWithin(candidate, target))
    if (!root) throw outsideError(requested)

    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        handle = await open(target, 'r')
        // Resolve again after opening so a swapped symlink cannot silently
        // redirect the read outside the allowlist.
        const verified = await realpath(unresolved)
        if (!isWithin(root, verified)) throw outsideError(requested)
        if (verified !== target) {
            throw new ContainedReadError('swapped', 'file changed while it was being opened')
        }
        const stats = await handle.stat()
        if (!stats.isFile()) {
            throw new ContainedReadError('not-a-file', 'path is not a regular file')
        }
        if (stats.size > options.maxBytes) {
            throw new ContainedReadError(
                'too-large',
                `file exceeds the ${options.maxBytes} byte limit`
            )
        }
        const bytes = await handle.readFile()
        return {
            root,
            path: verified,
            relative: path.relative(root, verified).split(path.sep).join('/'),
            filename: path.basename(verified),
            bytes,
            size: bytes.length
        }
    } finally {
        await handle?.close()
    }
}

function outsideError(requested: string) {
    return new ContainedReadError(
        'outside',
        `path is outside the configured allowlist: ${requested}`
    )
}

function normalize(value: string) {
    return path.resolve(value)
}
