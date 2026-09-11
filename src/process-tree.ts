import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_GRACE_MS = 2_000
const FORCE_KILL_WAIT_MS = 1_000
// Enumerating the process table costs about 1.3s on an idle machine (roughly
// 0.4s of PowerShell startup plus the CIM query) and more when the gateway is
// busy. The previous 1.2s cap sat just below that, so the sweep timed out and
// silently found nothing; leave headroom for the query to actually finish.
const PROCESS_TABLE_TIMEOUT_MS = 2_500
const PROCESS_TABLE_TTL_MS = 1_000
// Ceiling for one orphan sweep. The sweep runs on every teardown — including a
// failed ACP startup, which callers bound at five seconds — so it must stay
// bounded: an incomplete sweep beats a teardown that never returns.
const ORPHAN_SWEEP_BUDGET_MS = 3_000
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
            // Enumerating the process table is the slowest step of a Windows
            // teardown and does not depend on the leader being gone, so start
            // it alongside the kill instead of after it. The snapshot then
            // predates the tree kill, which the liveness filter below handles.
            const table = windowsProcessTable()
            await taskkill(pid, true)
            if (!(await waitForExit(child, Math.max(graceMs, FORCE_KILL_WAIT_MS)))) {
                // A forced kill can still lose the race on a loaded machine,
                // where the process takes longer than the wait to disappear.
                await taskkill(pid, true)
                await waitForExit(child, FORCE_KILL_WAIT_MS)
            }
            // A forced `taskkill /T` walks the tree as it exists at that
            // instant, so a child spawned moments before the leader died
            // survives as an orphan holding ports, file locks and inherited
            // pipes. Sweep by parent id for whatever the tree kill missed.
            await terminateOrphanedDescendants(pid, ORPHAN_SWEEP_BUDGET_MS, table)
        } else {
            // A leader that exited before we got here cannot be addressed by
            // taskkill at all, so nothing has swept its descendants yet.
            await terminateOrphanedDescendants(pid)
        }
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
    return new Promise<boolean>((resolve) => {
        const args = ['/PID', String(pid), '/T']
        if (force) args.push('/F')
        let killer: ChildProcess
        try {
            killer = spawn(
                'taskkill.exe',
                args,
                { stdio: 'ignore', windowsHide: true }
            )
        } catch {
            resolve(false)
            return
        }
        let settled = false
        const finish = (killed: boolean) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(killed)
        }
        const timer = setTimeout(() => {
            try { killer.kill() } catch {}
            finish(false)
        }, FORCE_KILL_WAIT_MS)
        killer.once('error', () => finish(false))
        killer.once('exit', (code) => finish(code === 0))
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
async function terminateOrphanedDescendants(
    pid: number,
    budgetMs = ORPHAN_SWEEP_BUDGET_MS,
    table?: Promise<Map<number, number[]> | undefined>
) {
    const deadline = Date.now() + budgetMs
    const snapshot = await (table ?? windowsProcessTable())
    // The snapshot may predate a caller's tree kill, and each taskkill costs
    // the better part of a second, so only ever aim at processes still alive.
    const doomed = collectDescendants(snapshot, pid).filter((target) => processAlive(target))
    if (!doomed.length) return
    // `collectDescendants` already returns the whole descendant tree, so kill
    // them together rather than paying the taskkill cost once per process.
    await Promise.all(doomed.map((target) => taskkill(target, true)))
    // Killing a parent can strand its own children, but the first pass covered
    // the entire tree, so a rescan only pays off when one of the targets is
    // still alive. Each rescan costs another full enumeration.
    if (Date.now() >= deadline) return
    if (!doomed.some((target) => processAlive(target))) return
    const remaining = collectDescendants(await windowsProcessTable(true), pid)
        .filter((survivor) => processAlive(survivor))
    await Promise.all(remaining.map((survivor) => taskkill(survivor, true)))
}

function processAlive(pid: number) {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        // EPERM means the process exists but belongs to someone else.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
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
