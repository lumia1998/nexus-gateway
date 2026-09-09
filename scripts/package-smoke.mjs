import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const tarCommand = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
const workspace = path.resolve(process.cwd())
const artifact = path.resolve(workspace, process.argv[2] || 'nexus-gateway.tar.gz')
if (!existsSync(artifact)) throw new Error(`deployment artifact is missing: ${artifact}`)

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nexus-gateway-package-smoke-'))
const deploymentRoot = path.join(tempRoot, 'deployment')
const npmPackRoot = path.join(tempRoot, 'npm-pack')
const npmInstallRoot = path.join(tempRoot, 'npm-install')
await mkdir(deploymentRoot)
await mkdir(npmPackRoot)
await mkdir(npmInstallRoot)

try {
    const { stdout: listing } = await execFileAsync(tarCommand, ['-tzf', artifact], {
        cwd: workspace,
        windowsHide: true
    })
    assertSafeArchive(listing)
    const entries = listing.split(/\r?\n/).map((line) => line.replace(/^\.\//, ''))
    for (const entry of ['dist/', 'package.json', 'package-lock.json', 'examples/client.mjs']) {
        if (!entries.includes(entry)) throw new Error(`deployment artifact is missing ${entry}`)
    }

    await execFileAsync(tarCommand, ['-xzf', artifact, '-C', deploymentRoot], {
        cwd: workspace,
        windowsHide: true
    })
    await runNpm(['ci', '--omit=dev'], {
        cwd: deploymentRoot,
        maxBuffer: 8 * 1024 * 1024
    })

    // Exercise npm's package allowlist, then install the generated package into
    // a clean project. The service is started from node_modules below.
    await runNpm(['pack', '--ignore-scripts', '--pack-destination', npmPackRoot], {
        cwd: deploymentRoot,
        maxBuffer: 8 * 1024 * 1024
    })
    const packedName = (await readdir(npmPackRoot)).find((name) => name.endsWith('.tgz'))
    if (!packedName) throw new Error('npm pack did not produce an installable archive')
    const packedPath = path.join(npmPackRoot, packedName)
    await writeFile(path.join(npmInstallRoot, 'package.json'), '{"private":true}\n', 'utf8')
    await runNpm(['install', '--omit=dev', '--ignore-scripts', packedPath], {
        cwd: npmInstallRoot,
        maxBuffer: 8 * 1024 * 1024
    })

    const port = await freePort()
    const configPath = path.join(npmInstallRoot, 'smoke-config.json')
    const workspacePath = path.join(npmInstallRoot, 'smoke-workspace')
    await mkdir(workspacePath)
    await writeFile(
        configPath,
        `${JSON.stringify({
            initialized: false,
            listen: { host: '127.0.0.1', port },
            workspaceRoots: [workspacePath],
            apiKeys: [],
            agents: {}
        }, null, 2)}\n`,
        'utf8'
    )

    const cliPath = path.join(npmInstallRoot, 'node_modules', 'nexus-agentd', 'dist', 'cli.js')
    if (!existsSync(cliPath)) throw new Error(`installed package is missing ${cliPath}`)
    const child = spawn(process.execPath, [cliPath, '--config', configPath], {
        cwd: npmInstallRoot,
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    })
    let output = ''
    child.stdout?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_384) })
    child.stderr?.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_384) })
    try {
        await waitForGateway(port, child)
        const setupToken = await waitForSetupToken(child, () => output)
        const origin = `http://127.0.0.1:${port}`
        const initialized = await fetch(`${origin}/v1/bootstrap/initialize`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: JSON.stringify({
                setupToken,
                password: 'package-smoke-password',
                confirmPassword: 'package-smoke-password'
            })
        })
        if (initialized.status !== 201) throw new Error(`bootstrap smoke failed with HTTP ${initialized.status}`)

        const login = await fetch(`${origin}/v1/admin/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: JSON.stringify({ password: 'package-smoke-password' })
        })
        if (!login.ok) throw new Error(`admin login smoke failed with HTTP ${login.status}`)
        const setCookie = typeof login.headers.getSetCookie === 'function'
            ? login.headers.getSetCookie()[0]
            : login.headers.get('set-cookie')
        if (!setCookie) throw new Error('admin login smoke did not return a session cookie')
        const cookie = setCookie.split(';', 1)[0]

        const created = await fetch(`${origin}/v1/admin/api-keys`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                origin,
                cookie
            },
            body: JSON.stringify({ name: 'package-smoke', scope: { allAgents: true, agentIds: [] } })
        })
        if (created.status !== 201) throw new Error(`API Key smoke failed with HTTP ${created.status}`)
        const keyResult = await created.json()
        if (typeof keyResult.secret !== 'string' || !keyResult.secret) throw new Error('API Key smoke did not return a secret')

        const meta = await fetch(`${origin}/v1/meta`, {
            headers: { authorization: `Bearer ${keyResult.secret}` }
        })
        if (!meta.ok) throw new Error(`client API smoke failed with HTTP ${meta.status}`)
        const ui = await fetch(`${origin}/ui/`)
        if (!ui.ok || !(await ui.text()).includes('<!doctype html>')) throw new Error('embedded UI smoke failed')
    } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`)
    } finally {
        await stopProcess(child)
    }
    console.log(`Package install/start smoke passed for ${path.basename(artifact)} on port ${port}`)
} finally {
    await rm(tempRoot, { recursive: true, force: true })
}

function npmCommand() {
    const npmExecPath = process.env.npm_execpath
    if (npmExecPath && npmExecPath.toLowerCase().endsWith('.js') && existsSync(npmExecPath)) {
        return { file: process.execPath, prefix: [npmExecPath] }
    }
    if (process.platform !== 'win32') return { file: 'npm', prefix: [] }

    // Batch files cannot be passed directly to execFile on Windows. Resolve
    // npm's JavaScript entrypoint and invoke it with the current Node binary,
    // keeping every user argument outside a shell.
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (existsSync(npmCli)) return { file: process.execPath, prefix: [npmCli] }
    const npmCmd = path.join(path.dirname(process.execPath), 'npm.cmd')
    if (existsSync(npmCmd)) {
        const command = readFileSync(npmCmd, 'utf8')
        const match = command.match(/node_modules[\\/]+npm[\\/]+bin[\\/]+npm-cli\.js/i)
        if (match) {
            const resolvedCli = path.resolve(path.dirname(npmCmd), match[0].replaceAll('\\', path.sep).replaceAll('/', path.sep))
            if (existsSync(resolvedCli)) return { file: process.execPath, prefix: [resolvedCli] }
        }
    }
    throw new Error('Unable to resolve npm-cli.js for a Windows package smoke')
}

async function runNpm(args, options) {
    const command = npmCommand()
    return execFileAsync(command.file, [...command.prefix, ...args], {
        ...options,
        windowsHide: true
    })
}

function assertSafeArchive(listing) {
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
        ) throw new Error(`unsafe deployment archive member: ${entry}`)
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer()
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            const port = typeof address === 'object' && address ? address.port : undefined
            server.close((error) => error ? reject(error) : resolve(port))
        })
    })
}

async function waitForGateway(port, child) {
    let lastError
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`gateway exited with ${child.exitCode}`)
        try {
            const response = await fetch(`http://127.0.0.1:${port}/health`)
            if (response.ok) return
            lastError = new Error(`HTTP ${response.status}`)
        } catch (error) {
            lastError = error
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`gateway did not become healthy: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function waitForSetupToken(child, readOutput) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`gateway exited with ${child.exitCode}`)
        const match = readOutput().match(/Setup token:\s*([^\s]+)/)
        if (match) return match[1]
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('gateway did not print a setup token')
}

async function stopProcess(child) {
    if (child.exitCode !== null) return
    child.kill('SIGTERM')
    const exited = await Promise.race([
        onceExit(child),
        new Promise((resolve) => setTimeout(() => resolve(false), 3_000))
    ])
    if (!exited && process.platform === 'win32' && child.pid) {
        await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).catch(() => undefined)
    }
}

function onceExit(child) {
    return new Promise((resolve) => child.once('exit', () => resolve(true)))
}
