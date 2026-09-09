import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
// Git Bash puts GNU tar on PATH; it interprets a Windows drive letter as a
// remote archive host. Use Windows' native tar for native filesystem paths.
const tarCommand = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
const workspace = path.resolve(option('--root') || process.cwd())
const artifact = path.resolve(workspace, option('--artifact') || 'nexus-gateway.tar.gz')

const packageFile = path.join(workspace, 'package.json')
const lockFile = path.join(workspace, 'package-lock.json')
const packageJson = JSON.parse(await readFile(packageFile, 'utf8'))
const packageLock = JSON.parse(await readFile(lockFile, 'utf8'))
const lockVersion = packageLock.packages?.['']?.version || packageLock.version
const version = option('--version') || lockVersion || packageJson.version

if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) {
    throw new Error(`Invalid deployment version: ${String(version)}`)
}
if (packageJson.version && lockVersion && packageJson.version !== lockVersion) {
    throw new Error(
        `package.json version ${packageJson.version} does not match package-lock.json version ${lockVersion}`
    )
}

const requiredFiles = [
    'dist',
    'package.json',
    'package-lock.json',
    'nexus-agentd.example.json',
    'deploy/nexus-agentd.service',
    'scripts/deploy-remote-install.sh'
]
const optionalFiles = ['README.md', 'LICENSE', 'deploy-manual.md', 'examples']
for (const relative of requiredFiles) await assertExists(path.join(workspace, relative))

const includedFiles = [...requiredFiles, ...optionalFiles].filter((relative) =>
    exists(path.join(workspace, relative))
)
const staging = await mkdtemp(path.join(os.tmpdir(), 'nexus-gateway-package-'))

try {
    for (const relative of includedFiles) {
        const source = path.join(workspace, relative)
        const target = path.join(staging, relative)
        await cp(source, target, { recursive: true })
    }

    const manifest = {
        format: 1,
        name: packageJson.name || 'nexus-agentd',
        version,
        files: includedFiles
    }
    await writeFile(path.join(staging, 'DEPLOY_VERSION'), `${version}\n`, 'utf8')
    await writeFile(
        path.join(staging, 'DEPLOY_MANIFEST.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
    )

    await rm(artifact, { force: true })
    await execFileAsync(tarCommand, ['-czf', artifact, '-C', staging, '.'], {
        cwd: workspace,
        windowsHide: true
    })
    await assertExists(artifact)
    const { stdout: listing } = await execFileAsync(tarCommand, ['-tzf', artifact], {
        cwd: workspace,
        windowsHide: true
    })
    assertSafeArchiveListing(listing)
    console.log(`Created ${path.relative(workspace, artifact) || artifact} (version ${version})`)
} finally {
    await rm(staging, { recursive: true, force: true })
}

function option(name) {
    const index = process.argv.indexOf(name)
    if (index < 0) return undefined
    const value = process.argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    return value
}

async function assertExists(file) {
    try {
        await stat(file)
    } catch {
        throw new Error(`Required deployment input is missing: ${path.relative(workspace, file)}`)
    }
}

function exists(file) {
    return existsSync(file)
}

function assertSafeArchiveListing(listing) {
    for (const entry of listing.split(/\r?\n/)) {
        const normalized = entry.replace(/^\.\//, '')
        if (!normalized) continue
        if (
            normalized.startsWith('/') ||
            normalized.startsWith('../') ||
            normalized.includes('/../') ||
            normalized.endsWith('/..') ||
            /^[A-Za-z]:\//.test(normalized) ||
            /(?:^|\/)[^/]+\.local(?:-runs)?\.json$/i.test(normalized)
        ) {
            throw new Error(`Unsafe deployment archive member: ${entry}`)
        }
    }
}
