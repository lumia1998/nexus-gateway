import { ControlPlaneError, validateRuntimeSettings, validateUpdate, validateAgentId, validateOpaqueId, validatePassword, validateKeyName, validateApiKeySecret, validateA2ASecret, validateAgentUrl, defaultAgentCardUrl, clampTimeout, preservedAcpAdvanced, setOptionalString, validHeaderName, safeSecretEqual, cleanString, recordValue, isRecord, errorMessage, type AgentdAgentUpdate, type AgentdApiKeyUpdate, type AgentdRuntimeSettingsUpdate } from './control-plane-validation.js'
export { ControlPlaneError, type AgentdAgentUpdate, type AgentdApiKeyUpdate, type AgentdRuntimeSettingsUpdate } from './control-plane-validation.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { hashAdminPassword, verifyAdminPassword } from './auth.js'
import { loadAgentdConfig } from './config.js'
import { createDriverRegistry } from './drivers/index.js'
import type { SessionManager } from './session.js'
import { agentdDriverKinds, type AgentdAgentConfig, type AgentdAgentConfigView, type AgentdApiKeyConfig, type AgentdApiKeyPrincipal, type AgentdApiKeyScope, type AgentdApiKeyView, type AgentdConfig, type AgentdControlPlaneView } from './types.js'
import { WorkspacePolicy } from './workspace.js'

export class AgentdControlPlane {
    /** Process-local proof, delivered only through the local CLI / embedding API. */
    setupToken?: string
    private queue = Promise.resolve()
    private usageTimer?: NodeJS.Timeout
    private readonly keyWatchers = new Set<() => void>()

    /** Observe authorization without updating last-used time or retaining a stale scope. */
    watchApiKey(keyId: string, secret: string, agentId: string, revoked: () => void) {
        const check = () => {
            const key = this.config.apiKeys?.find((item) => item.id === keyId && item.enabled && safeSecretEqual(item.secret, secret))
            if (!key || (!key.scope.allAgents && !key.scope.agentIds.includes(agentId))) {
                this.keyWatchers.delete(check)
                revoked()
            }
        }
        this.keyWatchers.add(check)
        check()
        return () => { this.keyWatchers.delete(check) }
    }

    constructor(
        private readonly configPath: string,
        private config: AgentdConfig,
        private readonly sessions: SessionManager
    ) {
        if (!config.adminPasswordHash) this.setupToken = randomBytes(32).toString('base64url')
    }

    verifySetupToken(token: string) {
        return Boolean(this.setupToken && safeSecretEqual(token, this.setupToken))
    }

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
            this.setupToken = undefined
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
        const protocol = update.protocol || previous.protocol || 'acp'
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
                timeoutMs: clampTimeout(update.timeoutMs ?? previous.timeoutMs as number | undefined, 60_000, 1000, 30 * 60_000)
            }
            for (const field of ['taskTimeoutMs', 'streamIdleTimeoutMs'] as const) {
                const value = update[field] === undefined ? previous[field] : update[field]
                if (value != null) {
                    next[field] = clampTimeout(value as number, 60_000,
                        field === 'taskTimeoutMs' ? 10_000 : 1000,
                        field === 'taskTimeoutMs' ? 24 * 60 * 60_000 : 30 * 60_000)
                }
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
                    update.permissionTimeoutMs ?? previous.permissionTimeoutMs as number | undefined,
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
            if (!Object.hasOwn(this.config.agents, id)) {
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
            for (const check of this.keyWatchers) check()
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
                timeoutMs: config.timeoutMs || 60_000,
                taskTimeoutMs: config.taskTimeoutMs,
                streamIdleTimeoutMs: config.streamIdleTimeoutMs
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
