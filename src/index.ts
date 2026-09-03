import type { Server } from 'node:http'
import path from 'node:path'
import { loadAgentdConfig } from './config.js'
import { AgentdControlPlane } from './control-plane.js'
import { createDriverRegistry } from './drivers/index.js'
import { createAgentdServer } from './server.js'
import { RunStore, runStorePathForConfig } from './run-store.js'
import { SessionManager } from './session.js'
import { WorkspacePolicy } from './workspace.js'

export async function startAgentd(configPath: string) {
    const absoluteConfigPath = path.resolve(configPath)
    const config = await loadAgentdConfig(absoluteConfigPath)
    const runStore = new RunStore(
        runStorePathForConfig(absoluteConfigPath),
        1000,
        config.maxRequestBytes
    )
    await runStore.init()
    const workspacePolicy = await WorkspacePolicy.create(config.workspaceRoots)
    const sessions = new SessionManager(
        config,
        workspacePolicy,
        createDriverRegistry(config),
        runStore
    )
    sessions.startCleanup()
    const controlPlane = new AgentdControlPlane(absoluteConfigPath, config, sessions)
    const server = createAgentdServer(config, sessions, controlPlane)
    let closing: Promise<void> | undefined
    const close = () => closing ??= (async () => {
        const results = await Promise.allSettled([closeServer(server), sessions.shutdown()])
        await runStore.flush()
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed) throw failed.reason
    })()
    try { await listen(server, config.listen.port, config.listen.host) } catch (error) {
        await sessions.shutdown()
        await runStore.flush()
        throw error
    }
    server.on('error', (error) => {
        console.error(JSON.stringify({ level: 'error', event: 'server_failed', message: error.message }))
        void close().catch((closeError) => {
            console.error(JSON.stringify({ level: 'error', event: 'server_shutdown_failed', message: String(closeError) }))
        })
    })
    return {
        config,
        server,
        sessions,
        runStore,
        controlPlane,
        close
    }
}

function listen(server: Server, port: number, host: string) {
    return new Promise<void>((resolve, reject) => {
        const error = (value: Error) => {
            server.off('listening', listening)
            reject(value)
        }
        const listening = () => {
            server.off('error', error)
            resolve()
        }
        server.once('error', error)
        server.once('listening', listening)
        server.listen(port, host)
    })
}

export function closeServer(server: Server, graceMs = 2_000) {
    return new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (error) reject(error)
            else resolve()
        }
        const timer = setTimeout(() => {
            server.closeAllConnections?.()
            finish()
        }, Math.max(0, graceMs))
        server.close((error) => finish(error || undefined))
        server.closeIdleConnections?.()
    })
}

export * from './config.js'
export * from './control-plane.js'
export * from './server.js'
export * from './run-store.js'
export * from './session.js'
export * from './types.js'
export * from './workspace.js'
