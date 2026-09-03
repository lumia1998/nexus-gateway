import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
    ContainedReadError,
    WorkspacePolicy,
    readContainedFile
} from '../src/workspace.js'

test('workspace policy accepts descendants and rejects traversal/outside paths', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-agentd-workspace-'))
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
