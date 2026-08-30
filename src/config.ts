import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
    agentdDriverKinds,
    type A2AAuthType,
    type A2ATransportPreference,
    type AgentdA2AConfig,
    type AgentdAgentConfig,
    type AgentdApiKeyConfig,
    type AgentdConfig,
    type AgentdDriverConfig,
    type AgentdDriverKind
} from './types.js'

export interface AgentdBootstrapOptions {
    host?: string
    port?: number
    workspace?: string
}

export async function ensureAgentdConfig(
    filePath: string,
    options: AgentdBootstrapOptions = {}
) {
    const absolute = path.resolve(filePath)
    try {
        await readFile(absolute, 'utf8')
        return { created: false as const }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const initial = {
        listen: {
            host: options.host?.trim() || '127.0.0.1',
            port: bootstrapNumber(options.port, 8787, 1, 65535)
        },
        initialized: false,
        workspaceRoots: [path.resolve(options.workspace || process.cwd())],
        sessionTtlMs: 24 * 60 * 60 * 1000,
        promptTimeoutMs: 30 * 60 * 1000,
        cleanupIntervalMs: 60_000,
        apiKeys: [],
        agents: {}
    }
    await mkdir(path.dirname(absolute), { recursive: true })
    try {
        const handle = await open(absolute, 'wx', 0o600)
        try {
            await handle.writeFile(`${JSON.stringify(initial, null, 2)}\n`, 'utf8')
            await handle.sync()
        } finally {
            await handle.close()
        }
        return { created: true as const }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return { created: false as const }
        }
        throw error
    }
}

export async function loadAgentdConfig(filePath: string): Promise<AgentdConfig> {
    const absolute = path.resolve(filePath)
    const raw = await readFile(absolute, 'utf8')
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch (error) {
        throw new Error(
            `Invalid nexus-agentd config JSON: ${error instanceof Error ? error.message : String(error)}`
        )
    }
    if (!isRecord(value)) throw new Error('nexus-agentd config root must be an object')

    const listen = optionalRecord(value.listen, 'listen') || {}
    const host = optionalString(listen.host, 'listen.host') || '127.0.0.1'
    const port = integerValue(listen.port, 'listen.port', 8787, 1, 65535)
    const initialized = optionalBoolean(value.initialized, 'initialized') ?? true
    const rawAuthToken = optionalString(value.authToken, 'authToken')
    const authToken = rawAuthToken ? resolveSecret(rawAuthToken) : undefined
    const adminPasswordHash = optionalString(
        value.adminPasswordHash,
        'adminPasswordHash'
    )
    const apiKeys = parseApiKeys(value.apiKeys)

    if (!initialized && (rawAuthToken || adminPasswordHash || apiKeys.length)) {
        throw new Error(
            'nexus-agentd pending setup must not contain authToken, credentials, or API keys'
        )
    }
    if (initialized && !authToken && !adminPasswordHash && !apiKeys.length) {
        throw new Error(
            'nexus-agentd requires an adminPasswordHash, authToken, or API key after initialization'
        )
    }
    if (authToken && !apiKeys.some((key) => secretsEqual(key.secret, authToken))) {
        apiKeys.unshift({
            id: 'legacy',
            name: 'Legacy Access Key',
            secret: authToken,
            enabled: true,
            scope: { allAgents: true, agentIds: [] },
            createdAt: 0
        })
    }

    const workspaceRoots = stringArray(value.workspaceRoots, 'workspaceRoots')
    if (!workspaceRoots.length) {
        throw new Error('nexus-agentd workspaceRoots must contain at least one path')
    }
    const rawAgents = requiredRecord(value.agents, 'agents')
    const agents: Record<string, AgentdAgentConfig> = {}
    for (const [id, input] of Object.entries(rawAgents)) {
        agents[id] = parseAgent(id, input)
    }

    return {
        listen: { host, port },
        initialized,
        authToken,
        adminPasswordHash,
        apiKeys,
        workspaceRoots,
        maxRequestBytes: integerValue(
            value.maxRequestBytes,
            'maxRequestBytes',
            1024 * 1024,
            1024,
            16 * 1024 * 1024
        ),
        maxAttachmentBytes: integerValue(
            value.maxAttachmentBytes,
            'maxAttachmentBytes',
            32 * 1024 * 1024,
            1024,
            64 * 1024 * 1024
        ),
        maxEventsPerSession: integerValue(
            value.maxEventsPerSession,
            'maxEventsPerSession',
            2048,
            64,
            100_000
        ),
        maxOutputChars: integerValue(
            value.maxOutputChars,
            'maxOutputChars',
            512 * 1024,
            16 * 1024,
            16 * 1024 * 1024
        ),
        sessionTtlMs: integerValue(
            value.sessionTtlMs,
            'sessionTtlMs',
            24 * 60 * 60 * 1000,
            60_000,
            30 * 24 * 60 * 60 * 1000
        ),
        cleanupIntervalMs: integerValue(
            value.cleanupIntervalMs,
            'cleanupIntervalMs',
            60_000,
            5_000,
            60 * 60 * 1000
        ),
        requestTimeoutMs: integerValue(
            value.requestTimeoutMs,
            'requestTimeoutMs',
            30_000,
            1_000,
            5 * 60_000
        ),
        promptTimeoutMs: integerValue(
            value.promptTimeoutMs,
            'promptTimeoutMs',
            30 * 60_000,
            10_000,
            24 * 60 * 60 * 1000
        ),
        maxSessions: integerValue(value.maxSessions, 'maxSessions', 64, 1, 10_000),
        maxSseConnections: integerValue(
            value.maxSseConnections,
            'maxSseConnections',
            128,
            1,
            10_000
        ),
        maxConnections: integerValue(
            value.maxConnections,
            'maxConnections',
            256,
            8,
            100_000
        ),
        adminSessionTtlMs: integerValue(
            value.adminSessionTtlMs,
            'adminSessionTtlMs',
            12 * 60 * 60 * 1000,
            5 * 60_000,
            7 * 24 * 60 * 60 * 1000
        ),
        secureAdminCookies:
            optionalBoolean(value.secureAdminCookies, 'secureAdminCookies') ?? false,
        agents
    }
}

export function resolveSecret(value: string) {
    if (!value.startsWith('env:')) return value
    const name = value.slice(4).trim()
    if (!name) throw new Error('Secret environment variable name is empty')
    const secret = process.env[name]
    if (!secret) throw new Error(`Secret environment variable is missing: ${name}`)
    return secret
}

function parseAgent(id: string, value: unknown): AgentdAgentConfig {
    const input = requiredRecord(value, `agents.${id}`)
    const protocol = optionalString(input.protocol, `agents.${id}.protocol`) || 'acp'
    if (protocol === 'a2a') return parseA2AAgent(id, input)
    if (protocol !== 'acp') throw new Error(`Unsupported protocol for ${id}: ${protocol}`)

    const driver = optionalString(input.driver, `agents.${id}.driver`) || inferDriver(id)
    if (!isAgentdDriverKind(driver)) {
        throw new Error(`Unsupported nexus-agentd driver: ${driver || id}`)
    }
    const permissionPolicy =
        optionalString(input.permissionPolicy, `agents.${id}.permissionPolicy`) || 'ask'
    if (
        permissionPolicy !== 'ask' &&
        permissionPolicy !== 'allow' &&
        permissionPolicy !== 'deny'
    ) {
        throw new Error(`Invalid permissionPolicy for ${id}`)
    }
    const result: AgentdDriverConfig = {
        protocol: 'acp',
        driver,
        name: optionalString(input.name, `agents.${id}.name`),
        description: optionalString(input.description, `agents.${id}.description`),
        enabled: optionalBoolean(input.enabled, `agents.${id}.enabled`) ?? true,
        workspace: optionalString(input.workspace, `agents.${id}.workspace`),
        command: optionalString(input.command, `agents.${id}.command`),
        args:
            input.args === undefined
                ? undefined
                : stringArray(input.args, `agents.${id}.args`),
        inheritEnv:
            input.inheritEnv === undefined
                ? undefined
                : stringArray(input.inheritEnv, `agents.${id}.inheritEnv`),
        env: optionalStringRecord(input.env, `agents.${id}.env`),
        permissionPolicy,
        permissionTimeoutMs: integerValue(
            input.permissionTimeoutMs,
            `agents.${id}.permissionTimeoutMs`,
            15 * 60 * 1000,
            1000,
            24 * 60 * 60 * 1000
        )
    }
    return result
}

function parseA2AAgent(id: string, input: Record<string, unknown>): AgentdA2AConfig {
    const agentCardUrl = optionalString(input.agentCardUrl, `agents.${id}.agentCardUrl`)
    const agentUrl = optionalString(input.agentUrl, `agents.${id}.agentUrl`)
    if (!agentCardUrl && !agentUrl) {
        throw new Error(`nexus-agentd agents.${id}.agentCardUrl is required`)
    }
    if (agentCardUrl) validateHttpUrl(agentCardUrl, `agents.${id}.agentCardUrl`)
    if (agentUrl) validateHttpUrl(agentUrl, `agents.${id}.agentUrl`)
    const preferredTransport = (optionalString(
        input.preferredTransport,
        `agents.${id}.preferredTransport`
    ) || 'auto') as A2ATransportPreference
    if (!['auto', 'jsonrpc', 'http-json'].includes(preferredTransport)) {
        throw new Error(`Invalid A2A preferredTransport for ${id}`)
    }
    const rawAuth = optionalRecord(input.auth, `agents.${id}.auth`)
    let auth: AgentdA2AConfig['auth']
    if (rawAuth) {
        const type = (optionalString(rawAuth.type, `agents.${id}.auth.type`) ||
            'none') as A2AAuthType
        if (!['none', 'bearer', 'header'].includes(type)) {
            throw new Error(`Invalid A2A auth type for ${id}`)
        }
        const rawValue = optionalString(rawAuth.value, `agents.${id}.auth.value`)
        const headerName = optionalString(
            rawAuth.headerName,
            `agents.${id}.auth.headerName`
        )
        if (type !== 'none' && !rawValue) {
            throw new Error(`A2A auth value is required for ${id}`)
        }
        if (type === 'header' && !validHeaderName(headerName || '')) {
            throw new Error(`A valid A2A auth headerName is required for ${id}`)
        }
        auth = {
            type,
            value: rawValue ? resolveSecret(rawValue) : undefined,
            headerName: type === 'header' ? headerName : undefined
        }
    }
    return {
        protocol: 'a2a',
        name: optionalString(input.name, `agents.${id}.name`),
        description: optionalString(input.description, `agents.${id}.description`),
        enabled: optionalBoolean(input.enabled, `agents.${id}.enabled`) ?? true,
        agentCardUrl,
        agentUrl,
        preferredTransport,
        auth,
        timeoutMs: integerValue(
            input.timeoutMs,
            `agents.${id}.timeoutMs`,
            60_000,
            1_000,
            30 * 60_000
        )
    }
}

function parseApiKeys(value: unknown): AgentdApiKeyConfig[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) throw new Error('nexus-agentd apiKeys must be an array')
    const ids = new Set<string>()
    return value.map((entry, index) => {
        const item = requiredRecord(entry, `apiKeys[${index}]`)
        const id = requiredString(item.id, `apiKeys[${index}].id`)
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
            throw new Error(`Invalid API key id: ${id}`)
        }
        if (ids.has(id)) throw new Error(`Duplicate API key id: ${id}`)
        ids.add(id)
        const rawSecret = requiredString(item.secret, `apiKeys[${index}].secret`)
        const scope = requiredRecord(item.scope, `apiKeys[${index}].scope`)
        const allAgents = optionalBoolean(
            scope.allAgents,
            `apiKeys[${index}].scope.allAgents`
        )
        if (allAgents === undefined) {
            throw new Error(`apiKeys[${index}].scope.allAgents is required`)
        }
        return {
            id,
            name: requiredString(item.name, `apiKeys[${index}].name`),
            secret: resolveSecret(rawSecret),
            enabled: optionalBoolean(item.enabled, `apiKeys[${index}].enabled`) ?? true,
            scope: {
                allAgents,
                agentIds: stringArray(
                    scope.agentIds ?? [],
                    `apiKeys[${index}].scope.agentIds`
                )
            },
            createdAt: integerValue(
                item.createdAt,
                `apiKeys[${index}].createdAt`,
                0,
                0,
                Number.MAX_SAFE_INTEGER
            ),
            lastUsedAt:
                item.lastUsedAt === undefined
                    ? undefined
                    : integerValue(
                          item.lastUsedAt,
                          `apiKeys[${index}].lastUsedAt`,
                          0,
                          0,
                          Number.MAX_SAFE_INTEGER
                      )
        }
    })
}

function inferDriver(id: string) {
    const value = id.trim().toLowerCase()
    return isAgentdDriverKind(value) ? value : ''
}

function isAgentdDriverKind(value: string): value is AgentdDriverKind {
    return (agentdDriverKinds as readonly string[]).includes(value)
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
    if (!isRecord(value)) throw new Error(`nexus-agentd ${name} must be an object`)
    return value
}

function optionalRecord(value: unknown, name: string) {
    if (value === undefined) return undefined
    return requiredRecord(value, name)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value: unknown, name: string) {
    const result = optionalString(value, name)
    if (!result) throw new Error(`nexus-agentd ${name} is required`)
    return result
}

function optionalString(value: unknown, name: string) {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new Error(`nexus-agentd ${name} must be a string`)
    return value.trim() || undefined
}

function optionalBoolean(value: unknown, name: string) {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new Error(`nexus-agentd ${name} must be a boolean`)
    return value
}

function stringArray(value: unknown, name: string) {
    if (!Array.isArray(value)) throw new Error(`nexus-agentd ${name} must be an array`)
    return value.map((entry, index) => requiredString(entry, `${name}[${index}]`))
}

function optionalStringRecord(value: unknown, name: string) {
    if (value === undefined) return undefined
    const input = requiredRecord(value, name)
    const result: Record<string, string> = {}
    for (const [key, item] of Object.entries(input)) {
        if (typeof item !== 'string') {
            throw new Error(`nexus-agentd ${name}.${key} must be a string`)
        }
        result[key] = item
    }
    return result
}

function integerValue(
    value: unknown,
    name: string,
    fallback: number,
    min: number,
    max: number
) {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new Error(`nexus-agentd ${name} must be an integer between ${min} and ${max}`)
    }
    return value
}

function bootstrapNumber(value: unknown, fallback: number, min: number, max: number) {
    const number = Number(value)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.trunc(number)))
}

function validHeaderName(value: string) {
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
}

function validateHttpUrl(value: string, name: string) {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error(`nexus-agentd ${name} must be a valid URL`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error(`nexus-agentd ${name} must be an http(s) URL without credentials or a fragment`)
    }
}

function secretsEqual(left: string, right: string) {
    return left.length === right.length && left === right
}
