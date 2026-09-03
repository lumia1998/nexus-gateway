import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { hashAdminPassword, validateAdminPassword, verifyAdminPassword } from './auth.js'
import { loadAgentdConfig } from './config.js'
import { createDriverRegistry } from './drivers/index.js'
import type { SessionManager } from './session.js'
import {
    agentdDriverKinds,
    type A2AAuthType,
    type A2ATransportPreference,
    type AgentdAgentConfig,
    type AgentdAgentConfigView,
    type AgentdApiKeyConfig,
    type AgentdApiKeyPrincipal,
    type AgentdApiKeyScope,
    type AgentdApiKeyView,
    type AgentdConfig,
    type AgentdControlPlaneView,
    type AgentdDriverKind,
    type AgentdProtocol,
    type PermissionPolicy
} from './types.js'
import { WorkspacePolicy } from './workspace.js'

export interface AgentdAgentUpdate {
    protocol?: AgentdProtocol
    driver?: AgentdDriverKind
    name?: string
    description?: string
    enabled?: boolean
    workspace?: string
    permissionPolicy?: PermissionPolicy
    permissionTimeoutMs?: number
    agentCardUrl?: string
    agentUrl?: string
    preferredTransport?: A2ATransportPreference
    authType?: A2AAuthType
    authValue?: string
    authHeaderName?: string
    timeoutMs?: number
}

export interface AgentdApiKeyUpdate {
    name?: string
    enabled?: boolean
    scope?: AgentdApiKeyScope
}

export interface AgentdRuntimeSettingsUpdate {
    sessionTtlMs: number
    promptTimeoutMs: number
    cleanupIntervalMs: number
}

export class AgentdControlPlane {
    private queue = Promise.resolve()
    private usageTimer?: NodeJS.Timeout

    constructor(
        private readonly configPath: string,
        private config: AgentdConfig,
        private readonly sessions: SessionManager
    ) {}

    snapshot(): AgentdControlPlaneView {
        return {
            workspaceRoots: [...this.config.workspaceRoots],
            driverKinds: [...agentdDriverKinds],
            sessionTtlMs: this.config.sessionTtlMs,
            promptTimeoutMs: this.config.promptTimeoutMs || 30 * 60 * 1000,
            cleanupIntervalMs: this.config.cleanupIntervalMs || 60_000,
            agents: Object.entries(this.config.agents)
                .map(([id, config]) => this.agentView(id, config))
                .sort((left, right) => left.name.localeCompare(right.name))
        }
    }

    isInitialized() {
        return this.config.initialized
    }

    needsAdminSetup() {
        return !this.config.adminPasswordHash
    }

    /** @deprecated Legacy data-plane key accessor. */
    accessKey() {
        return this.config.authToken
    }

    initializeAdminPassword(passwordInput: string, confirmationInput: string) {
        return this.exclusive(async () => {
            if (this.config.adminPasswordHash) {
                throw new ControlPlaneError(409, 'Console setup is already complete')
            }
            const password = validatePassword(passwordInput, confirmationInput)
            const raw = await this.readRawConfig()
            if (cleanString(raw.adminPasswordHash)) {
                throw new ControlPlaneError(409, 'Console setup is already complete')
            }
            raw.initialized = true
            raw.adminPasswordHash = await hashAdminPassword(password)
            if (!Array.isArray(raw.apiKeys)) raw.apiKeys = []
            await this.persist(raw)
            return { initialized: true as const, adminSetupRequired: false as const }
        })
    }

    /** @deprecated Kept as a clear error for integrations using the old bootstrap API. */
    initializeAccessKey() {
        throw new ControlPlaneError(
            410,
            'Access Key bootstrap was replaced by Console Password setup'
        )
    }

    verifyAdminPassword(password: string) {
        return verifyAdminPassword(password, this.config.adminPasswordHash)
    }

    changeAdminPassword(current: string, next: string, confirmation: string) {
        return this.exclusive(async () => {
            if (!(await this.verifyAdminPassword(current))) {
                throw new ControlPlaneError(403, 'Current Console Password is incorrect')
            }
            const password = validatePassword(next, confirmation)
            const raw = await this.readRawConfig()
            raw.adminPasswordHash = await hashAdminPassword(password)
            await this.persist(raw)
            return { changed: true as const }
        })
    }

    authenticateApiKey(secret: string): AgentdApiKeyPrincipal | undefined {
        for (const key of this.config.apiKeys || []) {
            if (!key.enabled || !safeSecretEqual(secret, key.secret)) continue
            this.markApiKeyUsed(key.id)
            return { id: key.id, scope: structuredClone(key.scope) }
        }
        return undefined
    }

    listApiKeys(): AgentdApiKeyView[] {
        return (this.config.apiKeys || [])
            .map((key) => this.apiKeyView(key))
            .sort((left, right) => right.createdAt - left.createdAt)
    }

    createApiKey(
        nameInput: string,
        scopeInput: AgentdApiKeyScope,
        customSecret?: string
    ) {
        return this.exclusive(async () => {
            const name = validateKeyName(nameInput)
            const scope = this.validateScope(scopeInput)
            const secret = customSecret
                ? validateApiKeySecret(customSecret)
                : `nx_sk_${randomBytes(24).toString('base64url')}`
            if ((this.config.apiKeys || []).some((key) => safeSecretEqual(key.secret, secret))) {
                throw new ControlPlaneError(409, 'API Key already exists')
            }
            const raw = await this.readRawConfig()
            const keys = this.rawApiKeys(raw)
            const key = {
                id: randomUUID(),
                name,
                secret,
                enabled: true,
                scope,
                createdAt: Date.now()
            }
            keys.push(key)
            raw.apiKeys = keys
            await this.persist(raw)
            return { key: this.apiKeyView(this.requireApiKey(key.id)), secret }
        })
    }

    updateApiKey(idInput: string, update: AgentdApiKeyUpdate) {
        const id = validateOpaqueId(idInput, 'API Key')
        return this.exclusive(async () => {
            const raw = await this.readRawConfig()
            const keys = this.rawApiKeys(raw)
            const index = keys.findIndex((item) => cleanString(item.id) === id)
            if (index < 0) throw new ControlPlaneError(404, 'API Key not found')
            const current = recordValue(keys[index])
            if (update.name !== undefined) current.name = validateKeyName(update.name)
            if (update.enabled !== undefined) current.enabled = update.enabled
            if (update.scope !== undefined) current.scope = this.validateScope(update.scope)
            keys[index] = current
            raw.apiKeys = keys
            await this.persist(raw)
            return this.apiKeyView(this.requireApiKey(id))
        })
    }

    deleteApiKey(idInput: string) {
        const id = validateOpaqueId(idInput, 'API Key')
        return this.exclusive(async () => {
            const raw = await this.readRawConfig()
            const keys = this.rawApiKeys(raw)
            const next = keys.filter((item) => cleanString(item.id) !== id)
            if (next.length === keys.length) {
                throw new ControlPlaneError(404, 'API Key not found')
            }
            raw.apiKeys = next
            if (id === 'legacy') delete raw.authToken
            await this.persist(raw)
            return { deleted: true as const }
        })
    }

    revealApiKey(idInput: string) {
        const id = validateOpaqueId(idInput, 'API Key')
        return { secret: this.requireApiKey(id).secret }
    }

    regenerateApiKey(idInput: string) {
        const id = validateOpaqueId(idInput, 'API Key')
        return this.exclusive(async () => {
            const raw = await this.readRawConfig()
            const keys = this.rawApiKeys(raw)
            const index = keys.findIndex((item) => cleanString(item.id) === id)
            if (index < 0) throw new ControlPlaneError(404, 'API Key not found')
            const secret = `nx_sk_${randomBytes(24).toString('base64url')}`
            keys[index] = { ...recordValue(keys[index]), secret }
            raw.apiKeys = keys
            if (id === 'legacy') raw.authToken = secret
            await this.persist(raw)
            return { key: this.apiKeyView(this.requireApiKey(id)), secret }
        })
    }

    /** @deprecated Rotates the migrated legacy key when present. */
    async rotateAccessKey() {
        const key = (this.config.apiKeys || []).find((item) => item.id === 'legacy')
        if (!key) throw new ControlPlaneError(404, 'Legacy Access Key not found')
        const result = await this.regenerateApiKey('legacy')
        return { accessKey: result.secret }
    }

    putWorkspaceRoots(values: string[]) {
        return this.exclusive(async () => {
            const workspaceRoots = Array.from(new Set(values.map(cleanString).filter(Boolean)))
            if (!workspaceRoots.length) {
                throw new ControlPlaneError(400, 'workspaceRoots must contain at least one path')
            }
            const policy = await WorkspacePolicy.create(workspaceRoots)
            for (const [id, agent] of Object.entries(this.config.agents)) {
                if (agent.protocol === 'a2a' || !agent.workspace) continue
                try {
                    await policy.resolve(agent.workspace)
                } catch {
                    throw new ControlPlaneError(409, `Workspace change would exclude agent: ${id}`)
                }
            }
            const raw = await this.readRawConfig()
            raw.workspaceRoots = workspaceRoots
            await this.persist(raw)
            return this.snapshot()
        })
    }

    putRuntimeSettings(update: AgentdRuntimeSettingsUpdate) {
        return this.exclusive(async () => {
            validateRuntimeSettings(update)
            const raw = await this.readRawConfig()
            raw.sessionTtlMs = update.sessionTtlMs
            raw.promptTimeoutMs = update.promptTimeoutMs
            raw.cleanupIntervalMs = update.cleanupIntervalMs
            await this.persist(raw)
            return this.snapshot()
        })
    }

    putAgent(idInput: string, update: AgentdAgentUpdate) {
        const id = validateAgentId(idInput)
        return this.exclusive(() => this.updateAgents(id, update))
    }

    deleteAgent(idInput: string) {
        const id = validateAgentId(idInput)
        return this.exclusive(async () => {
            const raw = await this.readRawConfig()
            const agents = recordValue(raw.agents)
            if (!Object.hasOwn(agents, id)) {
                throw new ControlPlaneError(404, `Configured agent not found: ${id}`)
            }
            delete agents[id]
            raw.agents = agents
            const keys = this.rawApiKeys(raw).map((entry) => {
                const key = recordValue(entry)
                const scope = recordValue(key.scope)
                if (Array.isArray(scope.agentIds)) {
                    scope.agentIds = scope.agentIds.filter((agentId) => agentId !== id)
                    key.scope = scope
                }
                return key
            })
            raw.apiKeys = keys
            await this.persist(raw)
            return this.snapshot()
        })
    }

    private async updateAgents(id: string, update: AgentdAgentUpdate) {
        validateUpdate(update)
        const raw = await this.readRawConfig()
        const agents = recordValue(raw.agents)
        const previous = recordValue(agents[id])
        let next: Record<string, unknown>
        const protocol = update.protocol || 'acp'
        if (protocol === 'a2a') {
            const requestedAgentCardUrl = cleanString(update.agentCardUrl)
            const requestedAgentUrl = cleanString(update.agentUrl)
            const previousAgentCardUrl = cleanString(previous.agentCardUrl)
            const previousAgentUrl = cleanString(previous.agentUrl)
            const selectedAgentCardUrl =
                requestedAgentCardUrl || (!requestedAgentUrl ? previousAgentCardUrl : '')
            const selectedAgentUrl =
                requestedAgentUrl || (!selectedAgentCardUrl ? previousAgentUrl : '')
            const agentCardUrl = selectedAgentCardUrl
                ? validateAgentUrl(selectedAgentCardUrl)
                : ''
            const agentUrl = selectedAgentUrl ? validateAgentUrl(selectedAgentUrl) : ''
            if (!agentCardUrl && !agentUrl) {
                throw new ControlPlaneError(400, 'A2A Agent Card URL is required')
            }
            const preferredTransport =
                update.preferredTransport ||
                cleanString(previous.preferredTransport) ||
                'auto'
            const previousAuth = recordValue(previous.auth)
            const authType = update.authType || cleanString(previousAuth.type) || 'none'
            if (!['none', 'bearer', 'header'].includes(authType)) {
                throw new ControlPlaneError(400, 'authType must be none, bearer, or header')
            }
            const authValue =
                update.authValue !== undefined
                    ? validateA2ASecret(update.authValue)
                    : cleanString(previousAuth.value)
            const authHeaderName =
                cleanString(update.authHeaderName) || cleanString(previousAuth.headerName)
            if (authType !== 'none' && !authValue) {
                throw new ControlPlaneError(400, 'A2A authentication value is required')
            }
            if (authType === 'header' && !validHeaderName(authHeaderName)) {
                throw new ControlPlaneError(400, 'A valid A2A header name is required')
            }
            next = {
                protocol: 'a2a',
                name: cleanString(update.name) || cleanString(previous.name) || id,
                enabled: update.enabled ?? previous.enabled !== false,
                ...(agentCardUrl ? { agentCardUrl } : { agentUrl }),
                preferredTransport,
                auth: {
                    type: authType,
                    ...(authType !== 'none' ? { value: authValue } : {}),
                    ...(authType === 'header' ? { headerName: authHeaderName } : {})
                },
                timeoutMs: clampTimeout(update.timeoutMs, 60_000, 1000, 30 * 60_000)
            }
        } else {
            const driver = update.driver || cleanString(previous.driver)
            if (!(agentdDriverKinds as readonly string[]).includes(driver)) {
                throw new ControlPlaneError(400, `Unsupported nexus-agentd driver: ${driver}`)
            }
            const workspace =
                cleanString(update.workspace) ||
                cleanString(previous.workspace) ||
                this.config.workspaceRoots[0]
            if (!workspace) throw new ControlPlaneError(400, 'workspace is required')
            await (await WorkspacePolicy.create(this.config.workspaceRoots)).resolve(workspace)
            next = {
                protocol: 'acp',
                driver,
                enabled: update.enabled ?? previous.enabled !== false,
                workspace,
                permissionPolicy:
                    update.permissionPolicy || cleanString(previous.permissionPolicy) || 'ask',
                permissionTimeoutMs: clampTimeout(
                    update.permissionTimeoutMs,
                    15 * 60_000,
                    1000,
                    24 * 60 * 60 * 1000
                ),
                ...preservedAcpAdvanced(previous)
            }
            if (cleanString(update.name) || cleanString(previous.name)) {
                next.name = cleanString(update.name) || cleanString(previous.name)
            }
        }
        setOptionalString(next, 'description', update.description ?? cleanString(previous.description))
        agents[id] = next
        raw.agents = agents
        await this.persist(raw)
        return this.snapshot()
    }

    private validateScope(input: AgentdApiKeyScope): AgentdApiKeyScope {
        if (!input || typeof input.allAgents !== 'boolean' || !Array.isArray(input.agentIds)) {
            throw new ControlPlaneError(400, 'scope must include allAgents and agentIds')
        }
        const agentIds = Array.from(new Set(input.agentIds.map(validateAgentId)))
        for (const id of agentIds) {
            if (!this.config.agents[id]) {
                throw new ControlPlaneError(400, `Configured agent not found: ${id}`)
            }
        }
        return { allAgents: input.allAgents, agentIds: input.allAgents ? [] : agentIds }
    }

    private requireApiKey(id: string) {
        const key = (this.config.apiKeys || []).find((item) => item.id === id)
        if (!key) throw new ControlPlaneError(404, 'API Key not found')
        return key
    }

    private apiKeyView(key: AgentdApiKeyConfig): AgentdApiKeyView {
        return {
            id: key.id,
            name: key.name,
            enabled: key.enabled,
            scope: structuredClone(key.scope),
            suffix: key.secret.slice(-4),
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt,
            legacy: key.id === 'legacy'
        }
    }

    private markApiKeyUsed(id: string) {
        const key = (this.config.apiKeys || []).find((item) => item.id === id)
        if (!key) return
        const now = Date.now()
        if (key.lastUsedAt && now - key.lastUsedAt < 60_000) return
        key.lastUsedAt = now
        if (this.usageTimer) return
        this.usageTimer = setTimeout(() => {
            this.usageTimer = undefined
            void this.exclusive(async () => {
                const raw = await this.readRawConfig()
                const keys = this.rawApiKeys(raw)
                for (const entry of keys) {
                    const currentId = cleanString(entry.id)
                    const current = (this.config.apiKeys || []).find(
                        (item) => item.id === currentId
                    )
                    if (current?.lastUsedAt) entry.lastUsedAt = current.lastUsedAt
                }
                raw.apiKeys = keys
                await this.persist(raw)
            }).catch((error) =>
                console.error(
                    JSON.stringify({
                        level: 'error',
                        event: 'api_key_usage_persist_failed',
                        message: errorMessage(error)
                    })
                )
            )
        }, 5_000)
        this.usageTimer.unref?.()
    }

    private rawApiKeys(raw: Record<string, unknown>) {
        const keys = Array.isArray(raw.apiKeys)
            ? raw.apiKeys.map((item) => recordValue(item))
            : []
        const legacySecret = cleanString(raw.authToken)
        if (legacySecret && !keys.some((item) => cleanString(item.id) === 'legacy')) {
            keys.unshift({
                id: 'legacy',
                name: 'Legacy Access Key',
                secret: legacySecret,
                enabled: true,
                scope: { allAgents: true, agentIds: [] },
                createdAt: 0
            })
        }
        return keys
    }

    private async readRawConfig() {
        let value: unknown
        try {
            value = JSON.parse(await readFile(path.resolve(this.configPath), 'utf8'))
        } catch (error) {
            throw new ControlPlaneError(500, `Unable to read config: ${errorMessage(error)}`)
        }
        if (!isRecord(value)) throw new ControlPlaneError(500, 'Config root must be an object')
        return structuredClone(value)
    }

    private async persist(raw: Record<string, unknown>) {
        const target = path.resolve(this.configPath)
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
        let moved = false
        try {
            const handle = await open(temporary, 'wx', 0o600)
            try {
                await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, 'utf8')
                await handle.sync()
            } finally {
                await handle.close()
            }
            const nextConfig = await loadAgentdConfig(temporary)
            const workspacePolicy = await WorkspacePolicy.create(nextConfig.workspaceRoots)
            for (const agent of Object.values(nextConfig.agents)) {
                if (agent.protocol === 'a2a') continue
                const workspace = agent.workspace || nextConfig.workspaceRoots[0]
                if (workspace) await workspacePolicy.resolve(workspace)
            }
            const drivers = createDriverRegistry(nextConfig)
            await rename(temporary, target)
            moved = true
            await chmod(target, 0o600).catch(() => undefined)
            this.config = nextConfig
            this.sessions.reconfigure(nextConfig, workspacePolicy, drivers)
        } finally {
            if (!moved) await rm(temporary, { force: true }).catch(() => undefined)
        }
    }

    private agentView(id: string, config: AgentdAgentConfig): AgentdAgentConfigView {
        if (config.protocol === 'a2a') {
            return {
                id,
                protocol: 'a2a',
                name: config.name || id,
                description: config.description,
                enabled: config.enabled !== false,
                agentCardUrl: config.agentCardUrl || defaultAgentCardUrl(config.agentUrl),
                agentUrl: config.agentUrl,
                preferredTransport: config.preferredTransport || 'auto',
                auth: {
                    type: config.auth?.type || 'none',
                    headerName: config.auth?.headerName,
                    configured: Boolean(config.auth?.value)
                },
                timeoutMs: config.timeoutMs || 60_000
            }
        }
        return {
            id,
            protocol: 'acp',
            driver: config.driver,
            name: config.name || id,
            description: config.description,
            enabled: config.enabled !== false,
            workspace: config.workspace || this.config.workspaceRoots[0] || '',
            permissionPolicy: config.permissionPolicy || 'ask',
            permissionTimeoutMs: config.permissionTimeoutMs || 15 * 60 * 1000
        }
    }

    private exclusive<T>(task: () => Promise<T>) {
        const result = this.queue.then(task, task)
        this.queue = result.then(
            () => undefined,
            () => undefined
        )
        return result
    }
}

export class ControlPlaneError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

function validateRuntimeSettings(update: AgentdRuntimeSettingsUpdate) {
    validateIntegerRange(update.sessionTtlMs, 60_000, 30 * 24 * 60 * 60 * 1000, 'sessionTtlMs')
    validateIntegerRange(update.promptTimeoutMs, 10_000, 24 * 60 * 60 * 1000, 'promptTimeoutMs')
    validateIntegerRange(update.cleanupIntervalMs, 5_000, 60 * 60 * 1000, 'cleanupIntervalMs')
}

function validateIntegerRange(value: number, min: number, max: number, name: string) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ControlPlaneError(400, `${name} must be between ${min} and ${max}`)
    }
}

function validateUpdate(update: AgentdAgentUpdate) {
    if (update.protocol !== undefined && update.protocol !== 'acp' && update.protocol !== 'a2a') {
        throw new ControlPlaneError(400, 'protocol must be acp or a2a')
    }
    if (
        update.permissionPolicy !== undefined &&
        update.permissionPolicy !== 'ask' &&
        update.permissionPolicy !== 'allow' &&
        update.permissionPolicy !== 'deny'
    ) {
        throw new ControlPlaneError(400, 'permissionPolicy must be ask, allow, or deny')
    }
    if (
        update.preferredTransport !== undefined &&
        !['auto', 'jsonrpc', 'http-json'].includes(update.preferredTransport)
    ) {
        throw new ControlPlaneError(
            400,
            'preferredTransport must be auto, jsonrpc, or http-json'
        )
    }
}

function validateAgentId(value: string) {
    const id = decodeURIComponent(value).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
        throw new ControlPlaneError(400, 'Invalid Agent ID')
    }
    return id
}

function validateOpaqueId(value: string, label: string) {
    const id = decodeURIComponent(value).trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
        throw new ControlPlaneError(400, `Invalid ${label} ID`)
    }
    return id
}

function validatePassword(value: string, confirmation: string) {
    if (value !== confirmation) {
        throw new ControlPlaneError(400, 'Console Password confirmation does not match')
    }
    try {
        return validateAdminPassword(value)
    } catch (error) {
        throw new ControlPlaneError(400, errorMessage(error))
    }
}

function validateKeyName(value: string) {
    const name = cleanString(value)
    if (!name) throw new ControlPlaneError(400, 'API Key name is required')
    if (name.length > 80) throw new ControlPlaneError(400, 'API Key name is too long')
    return name
}

function validateApiKeySecret(value: string) {
    const secret = cleanString(value)
    if (secret.length < 16) {
        throw new ControlPlaneError(400, 'Custom API Key must contain at least 16 characters')
    }
    if (Buffer.byteLength(secret, 'utf8') > 512) {
        throw new ControlPlaneError(400, 'Custom API Key must not exceed 512 bytes')
    }
    if (/^env:/i.test(secret) || /[\u0000-\u001f\u007f]/.test(secret)) {
        throw new ControlPlaneError(400, 'Custom API Key contains an unsupported value')
    }
    return secret
}

function validateA2ASecret(value: string) {
    const secret = cleanString(value)
    if (!secret) return ''
    if (
        /^env:/i.test(secret) ||
        Buffer.byteLength(secret, 'utf8') > 4096 ||
        /[\u0000\r\n]/.test(secret)
    ) {
        throw new ControlPlaneError(400, 'A2A authentication value is invalid')
    }
    return secret
}

function validateAgentUrl(value: string) {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new ControlPlaneError(400, 'A2A Agent Card URL is invalid')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new ControlPlaneError(
            400,
            'A2A Agent Card URL must use http(s) without credentials or a fragment'
        )
    }
    return url.toString().replace(/\/$/, '')
}

function defaultAgentCardUrl(agentUrl: string | undefined) {
    if (!agentUrl) return undefined
    return new URL('/.well-known/agent-card.json', agentUrl).toString()
}

function clampTimeout(value: number | undefined, fallback: number, min: number, max: number) {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ControlPlaneError(400, `timeout must be between ${min} and ${max}`)
    }
    return value
}

function preservedAcpAdvanced(previous: Record<string, unknown>) {
    const result: Record<string, unknown> = {}
    for (const key of ['command', 'args', 'inheritEnv', 'env']) {
        if (previous[key] !== undefined) result[key] = structuredClone(previous[key])
    }
    return result
}

function setOptionalString(
    target: Record<string, unknown>,
    key: string,
    value: string | undefined
) {
    const text = cleanString(value)
    if (text) target[key] = text
    else delete target[key]
}

function validHeaderName(value: string) {
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
}

function safeSecretEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function cleanString(value: unknown) {
    return typeof value === 'string' ? value.trim() : ''
}

function recordValue(value: unknown): Record<string, any> {
    return isRecord(value) ? { ...value } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
