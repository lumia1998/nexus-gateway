import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// `npm test` used to hand `test/*.test.ts` straight to the test runner. On Linux
// the shell expands that pattern before the runner sees it, but npm runs scripts
// through cmd.exe on Windows, where nothing expands it, and Node 20 does not
// expand globs in `--test` either. The literal pattern therefore reached the
// runner and the Windows CI job failed with "Could not find ...\test\*.test.ts".
// Resolving the file list here keeps one command working on every platform.
const workspace = process.cwd()
const directory = path.resolve(workspace, 'test')
const files = readdirSync(directory)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => path.join(directory, name))
if (files.length === 0) {
    throw new Error(`No test files found in ${directory}`)
}

const tsx = path.resolve(workspace, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const result = spawnSync(
    process.execPath,
    [
        tsx,
        '--test',
        '--test-force-exit',
        '--test-concurrency=1',
        ...files,
        ...process.argv.slice(2)
    ],
    { stdio: 'inherit' }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
