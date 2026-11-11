import type { SessionManager } from '../session.js'
import type { AgentdApiKeyPrincipal, AgentdRunDetail, AgentSessionOptions } from '../types.js'
import type { QuotaManager } from '../server/quota.js'
import { assertAgentScope } from '../server/auth-policy.js'
import { RequestError } from '../server/validation.js'
import { McpDispatchStore } from './dispatch-store.js'

export interface McpAccess { principal(): AgentdApiKeyPrincipal; signal?: AbortSignal }
export interface McpReservations {
    sessions: Map<string, () => void>
    runs: Map<string, () => void>
}
export interface DispatchInput {
    agent_id: string
    message: string
    request_id: string
    workspace?: string
    session_id?: string
    resume_task_id?: string
    options?: AgentSessionOptions
}

const terminal = (state: string) => ['completed', 'failed', 'canceled'].includes(state)

export class McpTasks {
    private receipts?: McpDispatchStore
    constructor(private readonly sessions: SessionManager, private readonly quota: QuotaManager, private readonly reservations: McpReservations) {}

    private authorize(access: McpAccess, agentId?: string) {
        const principal = access.principal()
        if (agentId) assertAgentScope(principal, agentId)
        return principal
    }

    private ownedTask(access: McpAccess, taskId: string) {
        const principal = this.authorize(access)
        if (!this.sessions.ownsRun(taskId, principal.id)) throw new RequestError(404, 'Task not found')
        const run = this.sessions.getRun(taskId)
        assertAgentScope(principal, run.agentId)
        return run
    }

    async listAgents(access: McpAccess, input: { agent_id?: string; refresh?: boolean; include_capabilities?: boolean; workspace?: string }) {
        const principal = this.authorize(access, input.agent_id)
        const ids = input.agent_id ? new Set([input.agent_id]) : principal.scope.allAgents ? undefined : new Set(principal.scope.agentIds)
        if (input.include_capabilities && !input.agent_id) throw new RequestError(400, 'include_capabilities requires agent_id')
        const rows = await this.sessions.listAgents(ids, input.refresh)
        this.authorize(access, input.agent_id)
        const agents = rows.map(row => ({
            agent_id: row.id, name: row.name, description: row.description, protocol: row.protocol, driver: row.driver,
            enabled: row.enabled, ready: row.ready, readiness: row.protocol === 'a2a' ? 'agent_card' : 'command_probe',
            error: row.error, version: row.version, checked_at: row.checkedAt,
            defaults: this.sessions.agentDefaults(row.id),
            delegation: 'Send subagent/team instructions in message. The worker handles them using its own capabilities; the gateway does not create or guarantee internal teams.'
        }))
        if (input.include_capabilities) {
            if (!agents.length) throw new RequestError(404, 'Agent not found')
            const release = this.quota.reserveSession(principal.id)
            let id: string | undefined
            try {
                this.authorize(access, input.agent_id)
                const created = await this.sessions.create(input.agent_id!, input.workspace, principal.id)
                id = created.id
                this.authorize(access, input.agent_id)
                return { instance_id: this.sessions.instanceId, agents, capabilities: created.runtime || null, capabilities_source: created.protocol === 'acp' ? 'acp_handshake' : 'runtime_configuration' }
            } finally {
                try { if (id) await this.sessions.close(id) } finally { release() }
            }
        }
        // Recheck the complete inventory against the live scope after probes finish.
        const current = this.authorize(access)
        return { instance_id: this.sessions.instanceId, agents: agents.filter(row => current.scope.allAgents || current.scope.agentIds.includes(row.agent_id)) }
    }

    async dispatch(access: McpAccess, input: DispatchInput) {
        const principal = this.authorize(access, input.agent_id)
        if (input.session_id && input.resume_task_id) throw new RequestError(400, 'Choose session_id or resume_task_id, not both')
        if (input.workspace && (input.session_id || input.resume_task_id)) throw new RequestError(400, 'Continuations keep their existing workspace')
        if (!input.message.trim()) throw new RequestError(400, 'message is required')
        const storePath = this.sessions.getRunStorePath()
        if (!storePath) throw new RequestError(503, 'MCP task dispatch requires persistent run storage')
        this.receipts ??= new McpDispatchStore(`${storePath}.mcp-dispatch.json`)
        const receipt = await this.receipts.once(principal.id, input.request_id, input, async () => {
            this.authorize(access, input.agent_id)
            let sessionId: string | undefined
            let created = false
            let releaseSession: (() => void) | undefined
            let releaseRun: (() => void) | undefined
            let accepted = false
            try {
                if (input.session_id) {
                    if (!this.sessions.owns(input.session_id, principal.id)) throw new RequestError(404, 'Session not found')
                    const current = this.sessions.get(input.session_id)
                    if (current.agentId !== input.agent_id) throw new RequestError(400, 'Session belongs to another agent')
                    sessionId = current.id
                } else if (input.resume_task_id) {
                    const run = this.ownedTask(access, input.resume_task_id)
                    if (run.agentId !== input.agent_id) throw new RequestError(400, 'Task belongs to another agent')
                    const restored = await this.sessions.resumeRun(run.id, principal.id, () => {
                        releaseSession = this.quota.reserveSession(principal.id)
                        created = true
                        return releaseSession
                    })
                    sessionId = restored.id
                    if (releaseSession) this.reservations.sessions.set(sessionId, releaseSession)
                } else {
                    releaseSession = this.quota.reserveSession(principal.id)
                    const session = await this.sessions.create(input.agent_id, input.workspace, principal.id, input.options)
                    sessionId = session.id
                    created = true
                    this.reservations.sessions.set(sessionId, releaseSession)
                }
                this.authorize(access, input.agent_id)
                const current = this.sessions.get(sessionId)
                if (current.state === 'running' || current.pendingRequest) throw new RequestError(409, 'Session is busy; use get_task or respond_task')
                const result = await this.sessions.dispatchMessage(sessionId, input.message, input.session_id || input.resume_task_id ? input.options : undefined, () => {
                    this.authorize(access, input.agent_id)
                    const release = this.quota.reserveRunningRun(principal.id, sessionId)
                    releaseRun = () => {
                        release()
                        if (this.reservations.runs.get(sessionId!) === releaseRun) this.reservations.runs.delete(sessionId!)
                    }
                    this.reservations.runs.set(sessionId!, releaseRun)
                })
                if (!result.runId) throw new Error('Dispatch did not create a persistent task')
                accepted = true
                try { await this.sessions.flushRuns() } catch {
                    throw new Error(`Task accepted (${result.runId}) but its history could not be persisted. Query this task_id; do not submit again automatically.`)
                }
                return { taskId: result.runId, sessionId }
            } catch (error) {
                // A disk error after acceptance must not cancel work or release its running quota.
                if (accepted) throw error
                releaseRun?.()
                if (sessionId && this.reservations.runs.get(sessionId) === releaseRun) this.reservations.runs.delete(sessionId)
                let retained = false
                try { retained = Boolean(created && sessionId && this.sessions.get(sessionId).runId) } catch { /* Session may have been closed concurrently. */ }
                if (!retained) {
                    if (created && sessionId) await this.sessions.close(sessionId).catch(() => undefined)
                    releaseSession?.()
                    if (sessionId && this.reservations.sessions.get(sessionId) === releaseSession) this.reservations.sessions.delete(sessionId)
                }
                throw error
            }
        })
        const run = this.ownedTask(access, receipt.task_id)
        return { ...receipt, instance_id: this.sessions.instanceId, state: run.state }
    }

    async getTask(access: McpAccess, input: { task_id: string; wait_seconds?: number; output_offset?: number; output_limit?: number; include_logs?: boolean; log_after?: string; log_limit?: number }) {
        let run = this.ownedTask(access, input.task_id)
        let timedOut = false
        if (!terminal(run.state) && !this.pending(run) && (input.wait_seconds || 0) > 0) {
            timedOut = await this.wait(access, run, input.wait_seconds!)
            run = this.ownedTask(access, input.task_id)
        }
        const output = run.output || ''
        const offset = input.output_offset ?? 0
        const limit = input.output_limit ?? 12_000
        const result = {
            instance_id: this.sessions.instanceId, task_id: run.id, session_id: run.sessionId, agent_id: run.agentId,
            state: run.state, progress: run.progress, wait_timed_out: timedOut, updated_at: run.updatedAt,
            error: run.error, pending_request: this.pending(run), completion: run.completion,
            output: output.slice(offset, offset + limit), output_chars: output.length,
            next_output_offset: offset + limit < output.length ? offset + limit : null,
            output_may_change: !terminal(run.state), artifacts: run.artifacts.map(artifact => ({ ...artifact,
                ...(artifact.downloadable && artifact.id ? { download_path: `/v1/runs/${encodeURIComponent(run.id)}/artifacts/${encodeURIComponent(artifact.id)}` } : {}) })),
            logs: input.include_logs ? this.logs(run, input.log_after, input.log_limit ?? 20) : undefined
        }
        this.authorize(access, run.agentId)
        return result
    }

    async cancel(access: McpAccess, taskId: string) {
        const run = this.ownedTask(access, taskId)
        if (terminal(run.state)) return { task_id: run.id, state: run.state, already_terminal: true }
        await this.sessions.cancelRun(taskId)
        const updated = this.ownedTask(access, taskId)
        return { task_id: taskId, state: updated.state }
    }

    async respond(access: McpAccess, input: { task_id: string; request_id: string; option_id?: string; message?: string; action?: 'accept' | 'decline' | 'cancel' }) {
        this.ownedTask(access, input.task_id)
        if (input.option_id === undefined && input.message === undefined && input.action === undefined) throw new RequestError(400, 'Provide option_id, message or action')
        await this.sessions.respondRun(input.task_id, { requestId: input.request_id, optionId: input.option_id, message: input.message, action: input.action })
        const run = this.ownedTask(access, input.task_id)
        return { task_id: run.id, state: run.state, pending_request: this.pending(run) }
    }

    private pending(run: AgentdRunDetail) {
        try { const session = this.sessions.get(run.sessionId); return session.runId === run.id ? session.pendingRequest : undefined } catch { return undefined }
    }

    private logs(run: AgentdRunDetail, after: string | undefined, limit: number) {
        const events = run.events || []
        const index = after ? events.findIndex(event => event.id === after) : -1
        const start = after && index >= 0 ? index + 1 : 0
        const page = events.slice(start, start + limit)
        return { events: page, cursor_reset: Boolean(after && index < 0), retention: 'last_256_events', has_more: start + page.length < events.length,
            next_cursor: page.at(-1)?.id ?? after ?? null }
    }

    private wait(access: McpAccess, run: AgentdRunDetail, seconds: number): Promise<boolean> {
        return new Promise((resolve, reject) => {
            let settled = false
            let timeout: NodeJS.Timeout | undefined
            let authTimer: NodeJS.Timeout | undefined
            let unsubscribe = () => {}
            const finish = (timedOut: boolean, error?: unknown) => {
                if (settled) return
                settled = true
                clearTimeout(timeout); clearInterval(authTimer); unsubscribe()
                access.signal?.removeEventListener('abort', aborted)
                error ? reject(error) : resolve(timedOut)
            }
            const check = () => {
                try {
                    const latest = this.ownedTask(access, run.id)
                    if (terminal(latest.state) || this.pending(latest)) finish(false)
                } catch (error) { finish(false, error) }
            }
            const aborted = () => finish(false, new Error('MCP request disconnected; the worker task continues'))
            try { unsubscribe = this.sessions.subscribe(run.sessionId, () => queueMicrotask(check)) }
            catch { finish(false); return }
            timeout = setTimeout(() => finish(true), seconds * 1000)
            authTimer = setInterval(check, 1000)
            access.signal?.addEventListener('abort', aborted, { once: true })
            if (access.signal?.aborted) aborted()
            else check()
        })
    }
}
