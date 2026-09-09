import { probeA2AAgent } from '../a2a/runtime.js'
import type { AgentDriver } from '../drivers/index.js'
import type { AgentdAgentView, AgentdConfig } from '../types.js'

/**
 * Dependencies needed by the readiness cache.  The error factory lives in
 * session.ts so callers still receive the gateway's normal request error type
 * without making this helper depend on SessionManager.
 */
export interface ReadinessOptions {
    requestError(status: number, message: string): Error
}

/**
 * Per-agent readiness probes are deliberately kept outside SessionManager.
 * Besides making the manager easier to reason about, this keeps an in-flight
 * probe shared by all callers and bounds the number of child processes or
 * remote card requests started by a dashboard refresh.
 */
export class SessionReadiness {
    private config: AgentdConfig
    private drivers: Map<string, AgentDriver>
    private cache = new Map<string, { checkedAt: number; agent: AgentdAgentView }>()
    private inFlight = new Map<
        string,
        { generation: number; promise: Promise<AgentdAgentView> }
    >()
    private generation = 0
    private activeProbes = 0
    private waiters: Array<() => void> = []

    constructor(
        config: AgentdConfig,
        drivers: Map<string, AgentDriver>,
        private readonly options: ReadinessOptions,
        private readonly maxConcurrent = 4,
        private readonly cacheMs = 20_000
    ) {
        this.config = config
        this.drivers = drivers
    }

    reconfigure(config: AgentdConfig, drivers: Map<string, AgentDriver>) {
        const probesChanged =
            JSON.stringify([this.config.agents, this.config.workspaceRoots]) !==
            JSON.stringify([config.agents, config.workspaceRoots])
        this.config = config
        this.drivers = drivers
        if (probesChanged) {
            this.generation++
            this.cache.clear()
            // Existing probes are allowed to settle.  The generation check
            // below prevents their results from becoming the new cache.
        }
    }

    async listAgents(agentIds?: Set<string>, force = false) {
        const now = Date.now()
        const catalogGeneration = this.generation
        const agents = await Promise.all(
            Object.entries(this.config.agents)
                .filter(([id]) => !agentIds || agentIds.has(id))
                .map(async ([id, config]) => {
                    const cached = this.cache.get(id)
                    if (
                        cached &&
                        now - cached.checkedAt < (force ? 5_000 : this.cacheMs)
                    ) {
                        return structuredClone(cached.agent)
                    }

                    const existing = this.inFlight.get(id)
                    if (existing) {
                        const value = await existing.promise
                        if (existing.generation !== this.generation) {
                            throw this.options.requestError(
                                409,
                                'Agent configuration changed; retry readiness'
                            )
                        }
                        return structuredClone(value)
                    }

                    const generation = this.generation
                    const probeAgent = async (): Promise<AgentdAgentView> => {
                        if (config.protocol === 'a2a') {
                            return probeA2AAgent(id, config)
                        }
                        if (config.enabled === false) {
                            return {
                                id,
                                name: config.name || id,
                                description: config.description,
                                protocol: 'acp',
                                driver: config.driver,
                                ready: false,
                                enabled: false,
                                workspace: this.defaultWorkspace(id),
                                error: 'Agent is disabled',
                                checkedAt: Date.now()
                            }
                        }
                        const driver = this.drivers.get(id)
                        if (!driver) {
                            return {
                                id,
                                name: config.name || id,
                                description: config.description,
                                protocol: 'acp',
                                driver: config.driver,
                                ready: false,
                                enabled: true,
                                workspace: this.defaultWorkspace(id),
                                error: 'ACP driver is unavailable',
                                checkedAt: Date.now()
                            }
                        }
                        const startedAt = Date.now()
                        try {
                            const probe = await driver.probe()
                            return {
                                ...probe,
                                protocol: 'acp' as const,
                                driver: config.driver,
                                enabled: true,
                                workspace: this.defaultWorkspace(id),
                                checkedAt: Date.now(),
                                responseMs: Date.now() - startedAt
                            }
                        } catch (error) {
                            return {
                                id,
                                name: config.name || id,
                                description: config.description,
                                protocol: 'acp',
                                driver: config.driver,
                                ready: false,
                                enabled: true,
                                workspace: this.defaultWorkspace(id),
                                error: errorMessage(error),
                                checkedAt: Date.now(),
                                responseMs: Date.now() - startedAt
                            }
                        }
                    }

                    const pending = this.withProbeSlot(async () => {
                        if (generation !== this.generation) {
                            throw this.options.requestError(
                                409,
                                'Agent configuration changed; retry readiness'
                            )
                        }
                        return probeAgent()
                    })
                    this.inFlight.set(id, { generation, promise: pending })
                    try {
                        const agent = await pending
                        if (generation === this.generation) {
                            this.cache.set(id, {
                                checkedAt: Date.now(),
                                agent: structuredClone(agent)
                            })
                        }
                        return agent
                    } finally {
                        if (this.inFlight.get(id)?.promise === pending) {
                            this.inFlight.delete(id)
                        }
                    }
                })
        )
        if (catalogGeneration !== this.generation) {
            throw this.options.requestError(
                409,
                'Agent configuration changed; retry readiness'
            )
        }
        agents.sort((left, right) => left.name.localeCompare(right.name))
        return agents.map((agent) => structuredClone(agent))
    }

    private async withProbeSlot<T>(operation: () => Promise<T>): Promise<T> {
        if (this.activeProbes < this.maxConcurrent) this.activeProbes++
        else await new Promise<void>((resolve) => this.waiters.push(resolve))
        try {
            return await operation()
        } finally {
            const next = this.waiters.shift()
            if (next) next()
            else this.activeProbes--
        }
    }

    private defaultWorkspace(agentId: string) {
        const config = this.config.agents[agentId]
        if (config?.protocol === 'a2a') return ''
        return config?.workspace || this.config.workspaceRoots[0] || ''
    }
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
