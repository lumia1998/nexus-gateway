import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { isPathInside, readContainedFile } from '../workspace.js'

const MAX_TEXT_BYTES = 16 * 1024 * 1024

/** File callbacks are restricted to the canonical session workspace, not all gateway roots. */
export async function readAcpText(workspace: string, requested: string, line?: number | null, limit?: number | null) {
    const file = await readContainedFile([workspace], requested, { maxBytes: MAX_TEXT_BYTES })
    const text = file.bytes!.toString('utf8')
    if (line == null && limit == null) return { content: text }
    if (line != null && (!Number.isInteger(line) || line < 1) || limit != null && (!Number.isInteger(limit) || limit < 0)) throw new Error('Invalid text range')
    const start = (line ?? 1) - 1
    return { content: text.split('\n').slice(start, limit == null ? undefined : start + limit).join('\n') }
}

export async function writeAcpText(workspace: string, requested: string, content: string) {
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) throw new Error('Text file exceeds 16 MiB')
    const unresolved = path.resolve(workspace, requested)
    const parent = await realpath(path.dirname(unresolved))
    if (!isPathInside(workspace, parent)) throw new Error('File is outside the session workspace')
    let target: string
    let existing = true
    try { target = await realpath(unresolved) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        existing = false
        target = path.join(parent, path.basename(unresolved))
    }
    if (!isPathInside(workspace, target)) throw new Error('File is outside the session workspace')
    // Never truncate before verifying the opened file. O_EXCL prevents following a newly planted link.
    const handle = await open(target, existing ? constants.O_RDWR | (constants.O_NOFOLLOW || 0) : 'wx', 0o600)
    try {
        const verified = await realpath(unresolved)
        if (verified !== target || !isPathInside(workspace, verified)) throw new Error('File path changed during write')
        const [opened, current] = await Promise.all([handle.stat(), stat(verified)])
        if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) throw new Error('File changed during write')
        await handle.truncate(0)
        await handle.writeFile(content, 'utf8')
    } finally { await handle.close() }
    return {}
}
