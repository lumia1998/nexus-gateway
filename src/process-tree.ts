import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_GRACE_MS = 2_000
const FORCE_KILL_WAIT_MS = 1_000
// Enumerating costs about a second on an idle machine and considerably more
// when the gateway is busy. The sweep runs on every teardown — including a
// failed ACP startup, which callers bound at five seconds — so it is capped
// short: an incomplete sweep beats a teardown that never returns.
const PROCESS_TABLE_TIMEOUT_MS = 1_200
const PROCESS_TABLE_TTL_MS = 1_000
// Windows reports a killed process as gone from `tasklist` slightly before the
// kernel closes the handles it held, so callers that delete the workspace or
// temp directory right after a teardown can still see EBUSY.
const PROCESS_EXIT_SETTLE_MS = 150

let processTableCache: { at: number; promise: Promise<Map<number, number[]> | undefined> } | undefined

export async function terminateProcessTree(
    child: ChildProcess,
    options: { ownsProcessGroup?: boolean; graceMs?: number } = {}
) {
    const pid = child.pid
    if (!pid) return
    const graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS)

    if (process.platform === 'win32') {
        // `taskkill` without /F only posts WM_CLOSE, which console processes
        // never handle: the graceful pass always fails and burns the whole
        // grace period before the forced retry. Force the tree kill directly.
        if (!hasExited(child)) {
            await taskkill(pid, true)
            if (!(await waitForExit(child, Math.max(graceMs, FORCE_KILL_WAIT_MS)))) {
                // A forced kill can still lose the race on a loaded machine,
                // where the process takes longer than the wait to disappear.
                await taskkill(pid, true)
                await waitForExit(child, FORCE_KILL_WAIT_MS)
            }
        }
        // A forced `taskkill /T` walks the tree as it exists at that instant,
        // so a child spawned moments before the leader died survives as an
        // orphan holding ports, file locks and inherited pipes — and a leader
        // that exited before we got here cannot be addressed by taskkill at
        // all. Sweep by parent id in both cases.
        await terminateOrphanedDescendants(pid)
        if (hasExited(child)) {
            await delay(PROCESS_EXIT_SETTLE_MS)
            return
        }
        throw new Error(`Failed to terminate process ${pid}`)
    }

    if (options.ownsProcessGroup === true) {
        signalUnixGroup(pid, 'SIGTERM')
        if (await waitForUnixGroupExit(pid, graceMs)) return
        signalUnixGroup(pid, 'SIGKILL')
        if (await waitForUnixGroupExit(pid, FORCE_KILL_WAIT_MS)) return
        throw new Error(`Failed to terminate process group ${pid}`)
    }

    signalUnix(child, 'SIGTERM')
    if (await waitForExit(child, graceMs)) return
    signalUnix(child, 'SIGKILL')
    if (await waitForExit(child, FORCE_KILL_WAIT_MS)) return
    throw new Error(`Failed to terminate process ${pid}`)
}

function signalUnix(child: ChildProcess, signal: NodeJS.Signals) {
    try {
        child.kill(signal)
    } catch {}
}

function signalUnixGroup(pid: number, signal: NodeJS.Signals) {
    try {
        process.kill(-pid, signal)
    } catch {}
}

async function waitForUnixGroupExit(pid: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs
    while (unixGroupExists(pid)) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return false
        await delay(Math.min(25, remaining))
    }
    return true
}

function unixGroupExists(pid: number) {
    try {
        process.kill(-pid, 0)
        return true
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
    if (hasExited(child)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (exited: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            child.off('exit', onExit)
            resolve(exited)
        }
        const onExit = () => finish(true)
        const timer = setTimeout(() => finish(hasExited(child)), timeoutMs)
        child.once('exit', onExit)
        if (hasExited(child)) finish(true)
    })
}

function taskkill(pid: number, force: boolean) {
    return new Promise<void>((resolve) => {
        const args = ['/PID', String(pid), '/T']
        if (force) args.push('/F')
        const killer = spawn(
            'taskkill.exe',
            args,
            { stdio: 'ignore', windowsHide: true }
        )
        const timer = setTimeout(() => {
            killer.kill()
            resolve()
        }, FORCE_KILL_WAIT_MS)
        const finish = () => {
            clearTimeout(timer)
            resolve()
        }
        killer.once('error', finish)
        killer.once('exit', finish)
    })
}

/**
 * Kills every process that still records `pid` as an ancestor.
 *
 * `taskkill /T` walks the live process tree, so it cannot reach children once
 * their parent has exited. Windows keeps the original parent id on the child
 * after that, which is enough to find the survivors. Best-effort by design: an
 * unreadable process table just leaves the sweep incomplete.
 */
async function terminateOrphanedDescendants(pid: number) {
    const doomed = collectDescendants(await windowsProcessTable(), pid)
    if (!doomed.length) return
    for (const target of doomed) await taskkill(target, true)
    // Killing a parent can strand its own children, so rescan for what is left.
    const remaining = collectDescendants(await windowsProcessTable(true), pid)
    for (const survivor of remaining) await taskkill(survivor, true)
}

function collectDescendants(table: Map<number, number[]> | undefined, root: number) {
    if (!table) return []
    const found: number[] = []
    const pending = [...(table.get(root) || [])]
    while (pending.length) {
        const next = pending.shift()!
        if (found.includes(next)) continue
        found.push(next)
        pending.push(...(table.get(next) || []))
    }
    return found
}

/**
 * Snapshots the Windows process table as parent id -> child ids. Enumerating
 * costs about a second, and a teardown that arrives alongside others (probing
 * every driver at startup, shutting a session down) asks the same question, so
 * concurrent callers share one snapshot. `refresh` bypasses it when the answer
 * has to describe the state after a kill.
 */
function windowsProcessTable(refresh = false) {
    const now = Date.now()
    if (!refresh && processTableCache && now - processTableCache.at < PROCESS_TABLE_TTL_MS) {
        return processTableCache.promise
    }
    const promise = snapshotProcessTable()
    processTableCache = { at: now, promise }
    return promise
}

function snapshotProcessTable() {
    return new Promise<Map<number, number[]> | undefined>((resolve) => {
        let lister: ChildProcess
        try {
            lister = spawn(
                'powershell.exe',
                [
                    '-NoProfile',
                    '-NonInteractive',
                    '-Command',
                    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'
                ],
                { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
            )
        } catch {
            resolve(undefined)
            return
        }
        let output = ''
        let settled = false
        const finish = (value: Map<number, number[]> | undefined) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(value)
        }
        const timer = setTimeout(() => {
            try { lister.kill() } catch {}
            finish(undefined)
        }, PROCESS_TABLE_TIMEOUT_MS)
        lister.stdout?.on('data', (chunk) => {
            output = `${output}${String(chunk)}`.slice(-4_000_000)
        })
        lister.once('error', () => finish(undefined))
        lister.once('exit', (code) => {
            finish(code === 0 ? parseProcessTable(output) : undefined)
        })
    })
}

function parseProcessTable(output: string) {
    const table = new Map<number, number[]>()
    for (const line of output.split(/\r?\n/)) {
        const match = /^(\d+)\s+(\d+)$/.exec(line.trim())
        if (!match) continue
        const child = Number(match[1])
        const parent = Number(match[2])
        const siblings = table.get(parent)
        if (siblings) siblings.push(child)
        else table.set(parent, [child])
    }
    return table
}

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function hasExited(child: ChildProcess) {
    return child.exitCode !== null || child.signalCode !== null
}
