import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
    ContainedReadError,
    WorkspacePolicy,
    isPathInside,
    isWithin,
    readContainedFile
} from '../src/workspace.js'

const execFileAsync = promisify(execFile)
const fsutil = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'fsutil.exe'
)

test('workspace policy accepts descendants and rejects traversal/outside paths', async () => {
    const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'nexus-agentd-workspace-'))
    const root = path.join(directory, 'allowed')
    const project = path.join(root, 'project')
    const outside = path.join(directory, 'outside')
    await mkdir(project, { recursive: true })
    await mkdir(outside, { recursive: true })
    try {
        const policy = await WorkspacePolicy.create([root])
        assert.equal(await policy.resolve(project), normalize(project))
        await assert.rejects(() => policy.resolve(outside), /outside the configured allowlist/)
        await assert.rejects(
            () => policy.resolve(path.join(project, '..', '..', 'outside')),
            /outside the configured allowlist/
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('workspace policy rejects a case-variant sibling inside a case-sensitive directory', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('case-sensitive directories are a Windows feature')
        return
    }
    // The fixture must stay under the canonical temp root: fsutil rejects the
    // case-sensitive attribute inside some managed trees (for example the DSH
    // workspace) with Access denied, and that is a bug in this test rather than
    // a missing host capability.
    const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'nexus-case-'))
    try {
        const probe = await enableCaseSensitivity(directory)
        if (!probe.enabled) {
            t.skip(probe.reason)
            return
        }
        const root = path.join(directory, 'repo')
        const sibling = path.join(directory, 'Repo')
        const secret = path.join(sibling, 'secret')
        await mkdir(root)
        await mkdir(secret, { recursive: true })
        await writeFile(path.join(secret, 'credentials.txt'), 'host-credential')
        // The queried attribute is authoritative, so anything but two distinct
        // directories means the fixture is broken, not that the host is limited.
        assert.notEqual(
            await realpath(root),
            await realpath(sibling),
            'the directory reports as case-sensitive but resolves both spellings to one directory'
        )

        const policy = await WorkspacePolicy.create([root])
        assert.equal(await policy.resolve(root), normalize(await realpath(root)))
        await assert.rejects(
            () => policy.resolve(secret),
            /outside the configured allowlist/
        )
    } finally {
        await disableCaseSensitivity(directory)
        await rm(directory, { recursive: true, force: true })
    }
})

test('isPathInside keeps containment case-sensitive and separator-aware', () => {
    const root = `root${path.sep}repo`
    assert.equal(isPathInside(root, root), true)
    assert.equal(isPathInside(root, `${root}${path.sep}child`), true)
    assert.equal(isPathInside(`${root}${path.sep}`, `${root}${path.sep}child`), true)
    // A sibling differing only by case is not inside. This is the A1 contract:
    // on a case-sensitive directory the two are genuinely different.
    assert.equal(isPathInside(root, `root${path.sep}Repo${path.sep}secret`), false)
    assert.equal(isPathInside(root, `root${path.sep}repo2`), false)
    assert.equal(isPathInside(root, `root${path.sep}repo2${path.sep}child`), false)
    assert.equal(isPathInside(`root${path.sep}`, `root${path.sep}anything`), true)
    // Lexical noise in a hand-written path is folded before comparing, which the
    // previous path.relative implementation also tolerated.
    assert.equal(
        isPathInside(`root${path.sep}a`, `root${path.sep}a${path.sep}..${path.sep}b`),
        false
    )
    assert.equal(
        isPathInside(`root${path.sep}a`, `root${path.sep}a${path.sep}.${path.sep}c`),
        true
    )
    assert.equal(
        isPathInside(`root${path.sep}a${path.sep}${path.sep}`, `root${path.sep}a${path.sep}c`),
        true
    )
})

test('isPathInside folds hand-written Windows spellings without lower-casing', {
    skip: process.platform !== 'win32'
}, () => {
    assert.equal(isPathInside('C:\\a', 'C:\\a\\..\\b'), false)
    assert.equal(isPathInside('C:\\a', 'C:\\a\\b'), true)
    assert.equal(isPathInside('C:\\a', 'C:\\a\\\\b'), true)
    assert.equal(isPathInside('C:\\a', 'C:\\a\\'), true)
    // path.resolve folds lexical noise but keeps the spelling, so the A1 fix
    // still holds for the previously published name.
    assert.equal(isPathInside('C:\\Repo', 'C:\\repo\\secret'), false)
})

test('isWithin keeps the published behaviour of isPathInside for the same inputs', () => {
    const root = `root${path.sep}repo`
    const targets = [
        root,
        `${root}${path.sep}`,
        `${root}${path.sep}child`,
        `${root}${path.sep}${path.sep}child`,
        `${root}${path.sep}.${path.sep}child`,
        `${root}${path.sep}child${path.sep}..`,
        `${root}${path.sep}..${path.sep}sibling`,
        `root${path.sep}Repo${path.sep}secret`,
        `root${path.sep}repo2`
    ]
    for (const target of targets) {
        assert.equal(
            isWithin(root, target),
            isPathInside(root, target),
            `isWithin and isPathInside disagreed for ${target}`
        )
    }
})

test('workspace policy admits a root spelled with different case on a case-insensitive volume', {
    skip: process.platform !== 'win32'
}, async () => {
    const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'nexus-case-normal-'))
    const root = path.join(directory, 'allowed')
    const project = path.join(root, 'project')
    await mkdir(project, { recursive: true })
    try {
        // realpath returns the spelling stored on disk, so an all-uppercase root
        // still resolves to the same directory and containment must still hold.
        const policy = await WorkspacePolicy.create([root.toUpperCase()])
        assert.equal(await policy.resolve(project), normalize(await realpath(project)))
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('workspace policy rejects symlink escapes', { skip: process.platform === 'win32' }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-symlink-'))
    const root = path.join(directory, 'allowed')
    const outside = path.join(directory, 'outside')
    const link = path.join(root, 'escape')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    try {
        try {
            await symlink(outside, link, 'dir')
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                t.skip('symlink creation is not permitted')
                return
            }
            throw error
        }
        const policy = await WorkspacePolicy.create([root])
        await assert.rejects(() => policy.resolve(link), /outside the configured allowlist/)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('readContainedFile reads from the matching root and reports the path relative to it', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-contained-'))
    await mkdir(path.join(directory, 'first'), { recursive: true })
    await mkdir(path.join(directory, 'second', 'nested'), { recursive: true })
    const first = await realpath(path.join(directory, 'first'))
    const second = await realpath(path.join(directory, 'second'))
    const target = path.join(second, 'nested', 'report.md')
    await writeFile(target, '# report')
    try {
        const file = await readContainedFile([first, second], target, { maxBytes: 1024 })
        assert.equal(file.root, second)
        assert.equal(file.relative, 'nested/report.md')
        assert.equal(file.filename, 'report.md')
        assert.equal(file.size, 8)
        assert.equal(file.bytes.toString('utf8'), '# report')
        assert.equal(file.path, target)
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('readContainedFile rejects paths outside every root', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-contained-outside-'))
    await mkdir(path.join(directory, 'allowed'), { recursive: true })
    const root = await realpath(path.join(directory, 'allowed'))
    const outside = path.join(directory, 'secret.txt')
    await writeFile(outside, 'host-credential')
    try {
        for (const requested of [outside, '../secret.txt', path.join(root, '..', 'secret.txt')]) {
            await assert.rejects(
                () => readContainedFile([root], requested, { maxBytes: 1024 }),
                (error: unknown) =>
                    error instanceof ContainedReadError && error.failure === 'outside'
            )
        }
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('readContainedFile fails closed when no root is configured', async () => {
    await assert.rejects(
        () => readContainedFile([], 'anything.txt', { maxBytes: 1024 }),
        (error: unknown) => error instanceof ContainedReadError && error.failure === 'outside'
    )
})

test('readContainedFile rejects directories and oversize files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-contained-kinds-'))
    const root = await realpath(directory)
    await mkdir(path.join(root, 'a-directory'), { recursive: true })
    await writeFile(path.join(root, 'big.bin'), 'x'.repeat(32))
    try {
        await assert.rejects(
            () => readContainedFile([root], 'a-directory', { maxBytes: 1024 }),
            (error: unknown) =>
                error instanceof ContainedReadError && error.failure === 'not-a-file'
        )
        await assert.rejects(
            () => readContainedFile([root], 'big.bin', { maxBytes: 16 }),
            (error: unknown) =>
                error instanceof ContainedReadError && error.failure === 'too-large'
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('readContainedFile rejects a symlink that escapes the root', { skip: process.platform === 'win32' }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-contained-link-'))
    const root = path.join(directory, 'allowed')
    const outside = path.join(directory, 'secret.txt')
    await mkdir(root, { recursive: true })
    await writeFile(outside, 'host-credential')
    try {
        try {
            await symlink(outside, path.join(root, 'escape.txt'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                t.skip('symlink creation is not permitted')
                return
            }
            throw error
        }
        const roots = [await realpath(root)]
        await assert.rejects(
            () => readContainedFile(roots, 'escape.txt', { maxBytes: 1024 }),
            (error: unknown) =>
                error instanceof ContainedReadError && error.failure === 'outside'
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

function normalize(value: string) {
    return path.resolve(value)
}

type CaseSensitivityProbe = { enabled: true } | { enabled: false; reason: string }

/**
 * Turns on per-directory case sensitivity for `directory`.
 *
 * Only a genuine host limitation produces a skip reason, and the
 * `queryCaseSensitiveInfo` output decides that rather than the exit code of the
 * command that enables the attribute. A fixture outside the canonical temp root
 * is a bug in this test, so it throws instead of skipping. `fsutil` only accepts
 * an empty directory, so callers must enable the attribute before creating the
 * case-variant entries.
 */
async function enableCaseSensitivity(directory: string): Promise<CaseSensitivityProbe> {
    const tempRoot = await realpath(os.tmpdir())
    assert.equal(
        isPathInside(tempRoot, directory),
        true,
        `case-sensitive fixtures must live under ${tempRoot}, not ${directory}`
    )
    let enableError = ''
    try {
        await execFileAsync(fsutil, ['file', 'setCaseSensitiveInfo', directory, 'enable'])
    } catch (error) {
        enableError = describeCommandError(error)
    }
    let state = ''
    try {
        state = (
            await execFileAsync(fsutil, ['file', 'queryCaseSensitiveInfo', directory])
        ).stdout
    } catch (error) {
        return {
            enabled: false,
            reason: `case-sensitive directories are unavailable: ${describeCommandError(error)}`
        }
    }
    if (/is enabled/i.test(state)) return { enabled: true }
    return {
        enabled: false,
        reason:
            `case sensitivity could not be enabled for ${directory}: ${state.trim()}` +
            (enableError ? ` (setCaseSensitiveInfo: ${enableError})` : '')
    }
}

function describeCommandError(error: unknown) {
    const details = error as { message?: string; stderr?: string; stdout?: string }
    return [details?.message, details?.stderr, details?.stdout]
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .join(' ')
}

async function disableCaseSensitivity(directory: string) {
    try {
        await execFileAsync(fsutil, ['file', 'setCaseSensitiveInfo', directory, 'disable'])
    } catch {
        // A directory that already holds case-variant siblings cannot be flipped
        // back; removing the whole temporary tree afterwards is enough.
    }
}
