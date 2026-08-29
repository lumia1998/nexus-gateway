import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ManagedSession, SessionRequestError } from '../src/session.js'

test('publishes regular workspace files without exposing the absolute path', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-publish-'))
    const workspace = path.join(directory, 'workspace')
    const outside = path.join(directory, 'outside.txt')
    await mkdir(path.join(workspace, 'dist'), { recursive: true })
    await writeFile(path.join(workspace, 'dist', 'report.md'), '# report')
    await writeFile(outside, 'secret')
    const session = managedSession(workspace)
    try {
        const artifact = await session.publishFile('dist/report.md')
        assert.equal(artifact.filename, 'report.md')
        assert.equal(artifact.bytesBase64, Buffer.from('# report').toString('base64'))
        assert.deepEqual(artifact.metadata, {
            source: 'workspace_publish',
            path: 'dist/report.md',
            size: 8
        })
        assert.equal(JSON.stringify(artifact).includes(directory), false)
        await assert.rejects(
            () => session.publishFile('../outside.txt'),
            (error: unknown) =>
                error instanceof SessionRequestError && error.status === 403
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('rejects workspace symlink escapes', { skip: process.platform === 'win32' }, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-publish-link-'))
    const workspace = path.join(directory, 'workspace')
    const outside = path.join(directory, 'outside.txt')
    await mkdir(workspace, { recursive: true })
    await writeFile(outside, 'secret')
    try {
        try {
            await symlink(outside, path.join(workspace, 'escape.txt'))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EPERM') {
                t.skip('symlink creation is not permitted')
                return
            }
            throw error
        }
        await assert.rejects(
            () => managedSession(workspace).publishFile('escape.txt'),
            (error: unknown) =>
                error instanceof SessionRequestError && error.status === 403
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

function managedSession(workspace: string) {
    return new ManagedSession(
        'opencode',
        'acp',
        workspace,
        'test-key',
        100,
        32 * 1024,
        'OpenCode'
    )
}
