#!/usr/bin/env node
import path from 'node:path'
import { networkInterfaces } from 'node:os'
import { ensureAgentdConfig } from './config.js'
import { startAgentd } from './index.js'

const args = process.argv.slice(2)
const configPath = resolveConfigPath(args)
const bootstrap = await ensureAgentdConfig(configPath, {
    host: option(args, '--host'),
    port: numberOption(args, '--port'),
    workspace: option(args, '--workspace')
})
const runtime = await startAgentd(configPath)
const address = runtime.server.address()
const label =
    typeof address === 'object' && address
        ? `${address.address}:${address.port}`
        : String(address)
console.log(`nexus-agentd listening on ${label}`)
for (const url of displayUrls(address)) console.log(`WebUI: ${url}`)
if (bootstrap.created) console.log(`Created config: ${configPath}`)
if (runtime.controlPlane.setupToken) {
    console.log('Setup required: enter the following one-time setup token in the WebUI, then create the Console Password.')
    console.log(`Setup token: ${runtime.controlPlane.setupToken}`)
    console.warn('Keep this token private. It changes on restart. Use a trusted network or HTTPS for remote setup.')
}

let closing: Promise<void> | undefined
const close = () => closing ??= runtime.close()
const shutdown = () => void close().then(() => process.exit(0), (error) => {
    console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', message: error instanceof Error ? error.message : String(error) }))
    process.exit(1)
})
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

function resolveConfigPath(args: string[]) {
    const index = args.indexOf('--config')
    const value = index >= 0 ? args[index + 1] : process.env.NEXUS_AGENTD_CONFIG
    return path.resolve(value || 'nexus-agentd.json')
}

function option(args: string[], name: string) {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
}

function numberOption(args: string[], name: string) {
    const value = option(args, name)
    if (value === undefined) return undefined
    const number = Number(value)
    if (!Number.isInteger(number)) throw new Error(`${name} must be an integer`)
    return number
}

function displayHost(address: ReturnType<typeof runtime.server.address>) {
    if (!address || typeof address === 'string') return '127.0.0.1'
    if (address.address === '0.0.0.0' || address.address === '::') {
        return '127.0.0.1'
    }
    return address.family === 'IPv6' ? `[${address.address}]` : address.address
}

function displayPort(address: ReturnType<typeof runtime.server.address>) {
    return address && typeof address === 'object' ? address.port : runtime.config.listen.port
}

function displayUrls(address: ReturnType<typeof runtime.server.address>) {
    const port = displayPort(address)
    if (
        address &&
        typeof address === 'object' &&
        (address.address === '0.0.0.0' || address.address === '::')
    ) {
        const hosts = new Set(['127.0.0.1'])
        for (const entries of Object.values(networkInterfaces())) {
            for (const entry of entries || []) {
                if (entry.family === 'IPv4' && !entry.internal) hosts.add(entry.address)
            }
        }
        return Array.from(hosts).map((host) => `http://${host}:${port}/ui/`)
    }
    return [`http://${displayHost(address)}:${port}/ui/`]
}
