import { spawn, type ChildProcess } from 'node:child_process'

const DEFAULT_GRACE_MS = 2_000
const FORCE_KILL_WAIT_MS = 1_000

export async function terminateProcessTree(
    child: ChildProcess,
    options: { ownsProcessGroup?: boolean; graceMs?: number } = {}
) {
    const pid = child.pid
    if (!pid || hasExited(child)) return
    const graceMs = Math.max(0, options.graceMs ?? DEFAULT_GRACE_MS)

    if (process.platform === 'win32') {
        await taskkill(pid, false)
        if (await waitForExit(child, graceMs)) return
        await taskkill(pid, true)
        await waitForExit(child, FORCE_KILL_WAIT_MS)
        return
    }

    if (options.ownsProcessGroup === true) {
        signalUnixGroup(pid, 'SIGTERM')
        if (await waitForUnixGroupExit(pid, graceMs)) return
        signalUnixGroup(pid, 'SIGKILL')
        await waitForUnixGroupExit(pid, FORCE_KILL_WAIT_MS)
        return
    }

    signalUnix(child, 'SIGTERM')
    if (await waitForExit(child, graceMs)) return
    signalUnix(child, 'SIGKILL')
    await waitForExit(child, FORCE_KILL_WAIT_MS)
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

function delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function hasExited(child: ChildProcess) {
    return child.exitCode !== null || child.signalCode !== null
}
