import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { loadAgentdConfig } from './config.js'
import { createDriverRegistry } from './drivers/index.js'
import type { SessionManager } from './session.js'
import {
    agentdDriverKinds,
    type AgentdAgentConfigView,
    type AgentdConfig,
    type AgentdControlPlaneView,
    type AgentdDriverConfig,
    type AgentdDriverKind,
    type PermissionPolicy
} from './types.js'
import { WorkspacePolicy } from './workspace.js'

export interface AgentdAgentUpdate {
    driver: AgentdDriverKind
    name?: string
    description?: string
    enabled?: boolean
    workspace?: string
    permissionPolicy?: PermissionPolicy
    permissionTimeoutMs?: number
}

export class AgentdControlPlane {
    private queue = Promise.resolve()

    constructor(
        private readonly configPath: string,
        private config: AgentdConfig,
        private readonly sessions: SessionManager
    ) {}

    snapshot(): AgentdControlPlaneView {
        return {
            workspaceRoots: [...this.config.workspaceRoots],
            driverKinds: [...agentdDriverKinds],
            agents: Object.entries(this.config.agents)
                .map(([id, config]) => this.agentView(id, config))
                .sort((left, right) => left.name.localeCompare(right.name))
        }
    }

    isInitialized() {
        return this.config.initialized
    }

    accessKey() {
        return this.config.authToken
    }

    initializeAccessKey(accessKeyInput: string, confirmationInput: string) {
        return this.exclusive(async () => {
            if (this.config.initialized) {
                throw new ControlPlaneError(409, 'Gateway setup is already complete')
            }
            const accessKey = validateInitialAccessKey(accessKeyInput)
            if (accessKey !== cleanString(confirmationInput)) {
                throw new ControlPlaneError(400, 'Access Key confirmation does not match')
            }
            const raw = await this.readRawConfig()
            if (raw.initialized !== false) {
                throw new ControlPlaneError(409, 'Gateway setup is already complete')
            }
            raw.initialized = true
            raw.authToken = accessKey
            await this.persist(raw)
            return { initialized: true as const }
        })
    }

    rotateAccessKey() {
        return this.exclusive(async () => {
            if (!this.config.initialized) {
                throw new ControlPlaneError(409, 'Gateway setup is required')
            }
            const raw = await this.readRawConfig()
            const accessKey = randomBytes(32).toString('base64url')
            raw.authToken = accessKey
            await this.persist(raw)
            return { accessKey }
        })
    }

    putWorkspaceRoots(values: string[]) {
        return this.exclusive(async () => {
            const workspaceRoots = Array.from(
                new Set(values.map(cleanString).filter(Boolean))
            )
            if (!workspaceRoots.length) {
                throw new ControlPlaneError(
                    400,
                    'workspaceRoots must contain at least one path'
                )
            }
            const raw = await this.readRawConfig()
            raw.workspaceRoots = workspaceRoots
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
                throw new ControlPlaneError(404, `Configured ACP agent not found: ${id}`)
            }
            delete agents[id]
            raw.agents = agents
            await this.persist(raw)
            return this.snapshot()
        })
    }

    private async updateAgents(id: string, update: AgentdAgentUpdate) {
        validateUpdate(update)
        const raw = await this.readRawConfig()
        const agents = recordValue(raw.agents)
        const previous = recordValue(agents[id])
        const workspace =
            cleanString(update.workspace) ||
            cleanString(previous.workspace) ||
            this.config.workspaceRoots[0]
        if (!workspace) {
            throw new ControlPlaneError(400, 'workspace is required')
        }
        await (await WorkspacePolicy.create(this.config.workspaceRoots)).resolve(workspace)

        const next: Record<string, unknown> = {
            ...previous,
            driver: update.driver,
            enabled:
                update.enabled === undefined
                    ? previous.enabled !== false
                    : update.enabled,
            workspace,
            permissionPolicy: update.permissionPolicy || 'ask',
            permissionTimeoutMs: clampTimeout(update.permissionTimeoutMs)
        }
        setOptionalString(next, 'name', update.name)
        setOptionalString(next, 'description', update.description)
        agents[id] = next
        raw.agents = agents
        await this.persist(raw)
        return this.snapshot()
    }

    private async readRawConfig() {
        let value: unknown
        try {
            value = JSON.parse(await readFile(path.resolve(this.configPath), 'utf8'))
        } catch (error) {
            throw new ControlPlaneError(
                500,
                `Unable to read nexus-agentd config: ${errorMessage(error)}`
            )
        }
        if (!isRecord(value)) {
            throw new ControlPlaneError(500, 'nexus-agentd config root must be an object')
        }
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

    private agentView(id: string, config: AgentdDriverConfig): AgentdAgentConfigView {
        return {
            id,
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

function validateUpdate(update: AgentdAgentUpdate) {
    if (!(agentdDriverKinds as readonly string[]).includes(update.driver)) {
        throw new ControlPlaneError(400, `Unsupported nexus-agentd driver: ${update.driver}`)
    }
    if (
        update.permissionPolicy !== undefined &&
        update.permissionPolicy !== 'ask' &&
        update.permissionPolicy !== 'deny'
    ) {
        throw new ControlPlaneError(400, 'permissionPolicy must be ask or deny')
    }
}

function validateAgentId(value: string) {
    const id = decodeURIComponent(value).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
        throw new ControlPlaneError(400, 'Invalid Agent ID')
    }
    return id
}

function validateInitialAccessKey(value: string) {
    const accessKey = cleanString(value)
    if (accessKey.length < 8) {
        throw new ControlPlaneError(
            400,
            'Access Key must contain at least 8 characters'
        )
    }
    if (Buffer.byteLength(accessKey, 'utf8') > 256) {
        throw new ControlPlaneError(400, 'Access Key must not exceed 256 bytes')
    }
    if (/^env:/i.test(accessKey)) {
        throw new ControlPlaneError(
            400,
            'Access Key must be a literal value, not an env: reference'
        )
    }
    if (/[\u0000-\u001f\u007f]/.test(accessKey)) {
        throw new ControlPlaneError(400, 'Access Key must not contain control characters')
    }
    return accessKey
}

function clampTimeout(value: number | undefined) {
    const number = Number(value)
    if (!Number.isFinite(number)) return 15 * 60 * 1000
    return Math.min(24 * 60 * 60 * 1000, Math.max(1000, Math.trunc(number)))
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

function cleanString(value: unknown) {
    return typeof value === 'string' ? value.trim() : ''
}

function recordValue(value: unknown): Record<string, unknown> {
    return isRecord(value) ? { ...value } : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
