import {
    spawn,
    type ChildProcessWithoutNullStreams,
    type SpawnOptions
} from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSecret } from '../config.js'
import { terminateProcessTree } from '../process-tree.js'
import type { AgentdDriverConfig } from '../types.js'
import type { AgentDriver } from './types.js'

const BASE_ENV_KEYS = [
    'PATH',
    'HOME',
    'USER',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'SHELL',
    'TMP',
    'TMPDIR',
    'TEMP',
    'LANG',
    'LC_ALL',
    // Node's Windows process creation and a number of ACP launchers require
    // these values even when the command itself is an absolute path.
    'SystemRoot',
    'ComSpec',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'PATHEXT'
]

export interface StdioAcpDriverDefaults {
    name: string
    description: string
    command: string
    args: string[]
    probeArgs?: string[]
    env?: Record<string, string>
}

export function createStdioAcpDriver(
    id: string,
    config: AgentdDriverConfig,
    defaults: StdioAcpDriverDefaults
): AgentDriver {
    const command = config.command || defaults.command
    const args = config.args === undefined ? [...defaults.args] : [...config.args]
    const env = buildEnvironment(config, defaults.env)
    const name = config.name || defaults.name
    const description = config.description || defaults.description
    return {
        id,
        name,
        description,
        command,
        args,
        env,
        permissionPolicy: config.permissionPolicy || 'ask',
        permissionTimeoutMs: config.permissionTimeoutMs || 15 * 60 * 1000,
        ownsProcessGroup: process.platform !== 'win32',
        async probe() {
            try {
                const version = await probeCommand(
                    command,
                    config.probeArgs || defaults.probeArgs || ['--version'],
                    env,
                    name,
                    { ownsProcessGroup: process.platform !== 'win32' }
                )
                return {
                    id,
                    name,
                    description,
                    protocol: 'acp',
                    ready: true,
                    version
                }
            } catch (error) {
                return {
                    id,
                    name,
                    description,
                    protocol: 'acp',
                    ready: false,
                    error: error instanceof Error ? error.message : String(error)
                }
            }
        },
        spawn(workspace) {
            return spawnCommand(command, args, {
                cwd: workspace,
                env,
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe']
            })
        }
    }
}

export function buildEnvironment(
    config: AgentdDriverConfig,
    defaults: Record<string, string> = {}
) {
    const result: NodeJS.ProcessEnv = {}
    for (const key of new Set([...BASE_ENV_KEYS, ...(config.inheritEnv || [])])) {
        const value = process.env[key]
        if (value !== undefined) result[key] = value
    }
    Object.assign(result, defaults)
    for (const [key, value] of Object.entries(config.env || {})) {
        result[key] = resolveSecret(value)
    }
    return result
}

export function probeCommand(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    label: string,
    options: { ownsProcessGroup?: boolean; timeoutMs?: number } = {}
) {
    return new Promise<string>((resolve, reject) => {
        const child = spawnCommand(command, args, {
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: options.ownsProcessGroup ?? process.platform !== 'win32',
            windowsHide: true
        })
        let output = ''
        let settled = false
        let finishing = false
        let timedOut = false
        let timer: NodeJS.Timeout | undefined
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            if (error) reject(error)
            else resolve(output.trim().split(/\r?\n/)[0] || 'unknown')
        }
        const ownsProcessGroup = options.ownsProcessGroup ?? process.platform !== 'win32'
        const cleanup = () => terminateProcessTree(child, {
            ownsProcessGroup,
            graceMs: 250
        })
        const cleanupFailure = (error: unknown) =>
            error instanceof Error ? error.message : String(error)
        const settleExit = (code: number | null, signal: NodeJS.Signals | null) => {
            if (settled || finishing || timedOut) return
            finishing = true
            if (timer) clearTimeout(timer)
            // A successful wrapper can leave a child in its process group.
            // Clean the group before exposing probe success/failure.
            void cleanup().then(
                () => {
                    if (timedOut || settled) return
                    finishing = false
                    if (code === 0) finish()
                    else {
                        finish(
                            new Error(
                                output.trim() ||
                                    `${label} probe exited with ${signal || code || 'unknown'}`
                            )
                        )
                    }
                },
                (error) => {
                    if (settled) return
                    finishing = false
                    finish(new Error(`${label} probe cleanup failed: ${cleanupFailure(error)}`))
                }
            )
        }
        timer = setTimeout(() => {
            if (settled || finishing || timedOut) return
            timedOut = true
            finishing = true
            if (timer) clearTimeout(timer)
            // Probe commands are allowed to be wrappers that launch another
            // process. Wait for tree termination before rejecting so a timed
            // out health check cannot leave an agent running in the background.
            void cleanup().then(
                () => finish(new Error(`${label} probe timed out`)),
                (error) => finish(new Error(
                    `${label} probe timed out; cleanup failed: ${cleanupFailure(error)}`
                ))
            )
        }, options.timeoutMs ?? 5000)
        timer.unref?.()
        child.stdout.on('data', (chunk) => {
            output = `${output}${String(chunk)}`.slice(-8192)
        })
        child.stderr.on('data', (chunk) => {
            output = `${output}${String(chunk)}`.slice(-8192)
        })
        child.once('error', (error) => {
            if (settled || finishing || timedOut) return
            finishing = true
            if (timer) clearTimeout(timer)
            void cleanup().then(
                () => finish(error),
                (cleanupError) => finish(new Error(
                    `${label} probe failed (${error.message}); cleanup failed: ${cleanupFailure(cleanupError)}`
                ))
            )
        })
        child.once('exit', (code, signal) => settleExit(code, signal))
    })
}

function needsWindowsShell(command: string) {
    return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
}

function spawnCommand(
    command: string,
    args: string[],
    options: SpawnOptions
): ChildProcessWithoutNullStreams {
    const resolvedCommand = resolveWindowsCommand(command, options.env, options.cwd)
    if (!needsWindowsShell(resolvedCommand)) {
        return spawn(resolvedCommand, args, options) as ChildProcessWithoutNullStreams
    }
    // cmd.exe's /S /C parser needs an outer pair around the complete command
    // when the batch path itself is quoted; otherwise it treats the first
    // argument as part of the executable path.
    const commandLine = `"${[quoteWindowsArg(resolvedCommand), ...args.map(quoteWindowsArg)].join(' ')}"`
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
        ...options,
        windowsVerbatimArguments: true,
        shell: false
    }) as ChildProcessWithoutNullStreams
}

function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv | undefined, cwd: SpawnOptions['cwd']) {
    if (process.platform !== 'win32') return command

    const pathValue = env?.PATH || process.env.PATH || ''
    const directory = cwd instanceof URL ? fileURLToPath(cwd) : cwd || process.cwd()
    const pathEntries = pathValue.split(path.delimiter).filter(Boolean).map((entry) => entry.replace(/^"|"$/g, ''))
    const pathExtValue = env?.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
    const extensions = pathExtValue
        .split(';')
        .map((extension) => extension.trim())
        .filter((extension) => /^\.(?:com|exe|bat|cmd)$/i.test(extension))

    // npm installs a POSIX shim without an extension beside its .cmd shim.
    // That file is not a Windows executable; selecting it makes real npm
    // commands fail even though a runnable .cmd exists in the same directory.
    const names = /\.(?:com|exe|bat|cmd)$/i.test(command)
        ? [command] : extensions.map((extension) => `${command}${extension}`)
    const candidates = commandHasPath(command)
        ? names.map((name) => path.resolve(directory, name))
        : [directory, ...pathEntries].flatMap((entry) => names.map((name) => path.resolve(directory, entry, name)))
    const match = candidates.find(isRegularFile)
    return match || command
}

function commandHasPath(command: string) {
    return command.includes('\\') || command.includes('/') || path.win32.isAbsolute(command)
}

function isRegularFile(file: string) {
    try {
        return existsSync(file) && statSync(file).isFile()
    } catch {
        return false
    }
}

function quoteWindowsArg(value: string) {
    if (!/[\s"&()^|<>]/.test(value)) return value
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/g, '$1$1')}"`
}
