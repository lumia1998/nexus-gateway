import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { ArtifactStoreError, GatewayArtifactStore } from '../src/artifact-store.js'
import { WorkspaceFileError, WorkspaceFiles } from '../src/workspace-files.js'

test('Gateway artifact storage publishes opaque expiring URLs without Base64', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-artifacts-'))
    const store = new GatewayArtifactStore(directory, 5_000, 1024)
    try {
        const published = await store.publishBytes(
            Buffer.from('artifact body'),
            'report 结果.txt',
            'text/plain; charset=utf-8',
            'session-1:artifact-1'
        )
        assert.match(published.id, /^[a-f0-9]{64}$/)
        assert.equal(published.name, 'report 结果.txt')
        assert.equal(published.size, 13)
        assert.equal(published.url.includes('artifact body'), false)

        const opened = await store.open(
            published.id,
            String(published.expiresAt),
            published.name
        )
        try {
            const chunks: Buffer[] = []
            for await (const chunk of opened.handle!.createReadStream({ autoClose: false })) {
                chunks.push(Buffer.from(chunk))
            }
            assert.equal(Buffer.concat(chunks).toString('utf8'), 'artifact body')
        } finally {
            await opened.handle!.close()
        }

        const duplicate = await store.publishBytes(
            Buffer.from('artifact body'),
            'report 结果.txt',
            undefined,
            'session-1:artifact-1'
        )
        assert.equal(duplicate.id, published.id)

        const independent = await store.publishBytes(Buffer.from('artifact body'), 'other.txt')
        assert.notEqual(independent.id, published.id)

        await assert.rejects(
            store.publishStream(Readable.from([Buffer.alloc(2048)]), 'large.bin'),
            (error: unknown) => error instanceof ArtifactStoreError && error.status === 413
        )

        const expiringDirectory = path.join(directory, 'expiring')
        const expiring = new GatewayArtifactStore(expiringDirectory, 40, 1024)
        const expired = await expiring.publishBytes(Buffer.from('short lived'), 'short.txt')
        await new Promise((resolve) => setTimeout(resolve, 80))
        const [storedName] = await readdir(expiringDirectory)
        await utimes(path.join(expiringDirectory, storedName), new Date(), new Date())
        await assert.rejects(
            expiring.open(expired.id, String(expired.expiresAt), expired.name),
            (error: unknown) => error instanceof ArtifactStoreError && error.status === 404
        )
        await expiring.cleanup()
    } finally {
        store.stopCleanup()
        await rm(directory, { recursive: true, force: true })
    }
})

test('Gateway artifact storage enforces a total retained-byte budget', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-capacity-'))
    const store = new GatewayArtifactStore(directory, 60_000, 16, 10, 10, 2)
    try {
        await store.publishBytes(Buffer.alloc(8, 1), 'first.bin')
        await assert.rejects(
            store.publishBytes(Buffer.alloc(4, 2), 'second.bin'),
            (error: unknown) =>
                error instanceof ArtifactStoreError &&
                error.status === 507 &&
                /capacity/.test(error.message)
        )
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
})

test('Workspace file operations stay inside an allowlisted root and stream uploads', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'agent-nexus-files-'))
    const root = path.join(parent, 'workspace')
    const outside = path.join(parent, 'outside.txt')
    await mkdir(root)
    await writeFile(path.join(root, 'inside.txt'), 'inside')
    await writeFile(outside, 'outside')
    const files = new WorkspaceFiles(() => [root], 16)
    try {
        const roots = await files.roots()
        assert.equal(roots.length, 1)
        assert.equal(await files.adminRoot(roots[0].id), await realpath(root))

        const listed = await files.list(root)
        assert.deepEqual(listed.entries.map((entry) => entry.name), ['inside.txt'])

        await assert.rejects(
            files.open(root, '../outside.txt'),
            (error: unknown) => error instanceof WorkspaceFileError && error.status === 403
        )

        const uploaded = await files.write(
            root,
            'nested.bin',
            Readable.from([Buffer.from('1234'), Buffer.from('5678')]),
            8
        )
        assert.deepEqual(uploaded, { path: 'nested.bin', size: 8 })
        assert.equal(await readFile(path.join(root, 'nested.bin'), 'utf8'), '12345678')

        await assert.rejects(
            files.write(root, 'too-large.bin', Readable.from([Buffer.alloc(17)])),
            (error: unknown) => error instanceof WorkspaceFileError && error.status === 413
        )

        await files.createDirectory(root, 'output')
        await files.move(root, 'nested.bin', path.join('output', 'renamed.bin'))
        assert.equal(await readFile(path.join(root, 'output', 'renamed.bin'), 'utf8'), '12345678')
        await files.remove(root, 'output')
        await assert.rejects(readFile(path.join(root, 'output', 'renamed.bin')))
    } finally {
        await rm(parent, { recursive: true, force: true })
    }
})
