#!/usr/bin/env node
import path from 'node:path'
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
console.log(`WebUI: http://${displayHost(address)}:${displayPort(address)}/ui/`)
if (bootstrap.created) {
    console.log(`Created config: ${configPath}`)
    console.log('Setup required: open the WebUI and choose your Gateway Access Key.')
    if (runtime.config.listen.host !== '127.0.0.1' && runtime.config.listen.host !== '::1') {
        console.warn(
            'WARNING: first-run setup is reachable over the network; initialize it immediately on a trusted network.'
        )
    }
}

let closing = false
const close = async () => {
    if (closing) return
    closing = true
    await runtime.close()
}
process.once('SIGINT', () => void close().finally(() => process.exit(0)))
process.once('SIGTERM', () => void close().finally(() => process.exit(0)))

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
