import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentDriver } from '../drivers/index.js'
import { terminateProcessTree } from '../process-tree.js'
import type { AcpSessionSink } from '../session-contract.js'
import type {
    AgentdArtifact,
    AgentdInputAttachment,
    AgentdPendingRequest,
    AgentdPendingResponse
} from '../types.js'
import { TURN_COMPLETION_CONTRACT } from '../completion-contract.js'
import { readContainedFile, statContainedFile, WorkspacePolicy } from '../workspace.js'
import type { AgentRuntimeView, AgentSessionOptions } from '../types.js'
import { parseSessionOptions } from '../runtime-options.js'
import { findOption, selectionValue, unattendedMode } from './selection.js'
import { readAcpText, writeAcpText } from './filesystem.js'

interface PendingPermission {
    request: AgentdPendingRequest
    resolve: (response: acp.RequestPermissionResponse) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
}

interface PendingInput {
    request: AgentdPendingRequest
    params: acp.CreateElicitationRequest
    resolve: (response: acp.CreateElicitationResponse) => void
    timer: NodeJS.Timeout
}

type FormElicitation = acp.CreateElicitationRequest & {
    mode: 'form'
    requestedSchema: acp.ElicitationSchema
}

// Matches MAX_PUBLISHED_FILE_BYTES in session.ts; larger files are encoded only to be dropped by the base64 budget.
/**
 * `MEDIA:` deliverables are copied by the artifact store instead of being
 * base64-inlined, so this ceiling matches the artifact ceiling (2 GiB).
 */
const MAX_MEDIA_MARKER_FILE_BYTES = 2 * 1024 ** 3
// The agent controls how many markers it emits, so bound the reads per turn.
const MAX_MEDIA_MARKER_ARTIFACTS = 8

export class AcpProcessRuntime {
    private process?: ChildProcessWithoutNullStreams
    private connection?: acp.ClientConnection
    private pending?: PendingPermission
    private pendingInput?: PendingInput
    private disposed = false
    private prompting = false
    private readonly maxStderrChunkChars: number
    private readonly promptTimeoutMs: number
    private promptCapabilities: acp.PromptCapabilities = {}
    private inputDirectory?: string
    private workspace?: string
    private promptOutput = ''
    private options: AgentSessionOptions
    private configOptions: acp.SessionConfigOption[] = []
    private modes?: acp.SessionModeState
    private resumeMethod?: 'resume' | 'load'
    private suspended = false
    private lastActivityAt = Date.now()
    private restoring = false
    private disposal?: Promise<void>

    constructor(
        private readonly driver: AgentDriver,
        private readonly sink: AcpSessionSink,
        maxStderrChunkChars = 16 * 1024,
        promptTimeoutMs = 30 * 60 * 1000,
        private readonly allowedRoots: readonly string[] = [],
        private readonly startupTimeoutMs = 30_000,
        options: AgentSessionOptions = {}
    ) {
        const limit = Number.isFinite(maxStderrChunkChars)
            ? Math.floor(maxStderrChunkChars)
            : 16 * 1024
        this.maxStderrChunkChars = Math.max(1, Math.min(16 * 1024, limit))
        this.promptTimeoutMs = Math.max(10_000, Math.trunc(promptTimeoutMs))
        const defaults: AgentSessionOptions = driver.config || {}
        this.options = { model: defaults.model, effort: defaults.effort, mode: defaults.mode, configOptions: defaults.configOptions,
            permissionPolicy: driver.permissionPolicy, ...options }
    }

    async start(workspace: string) {
        if (this.disposed) throw new Error('ACP runtime is disposed')
        if (this.process) throw new Error('ACP runtime is already started')
        try {
            await withTimeout(this.connect(workspace), this.startupTimeoutMs, 'ACP startup timed out')
        } catch (error) {
            if (this.sink.state !== 'canceled') this.onProcessFailure(error)
            await this.dispose()
            throw error
        }
    }

    private async connect(workspace: string) {
        if (this.process) throw new Error('ACP runtime is already started')
        this.workspace = workspace
        this.inputDirectory = path.join(workspace, '.nexus-inputs', this.sink.id)
        let args = [...this.driver.args]
        if (this.driver.kind === 'cursor' && this.options.model) {
            const index = args.indexOf('acp')
            if (index < 0) throw new Error('Cursor model selection requires an acp subcommand')
            args.splice(index, 0, '--model', this.options.model)
        }
        if (this.driver.kind === 'grok' && this.options.effort) {
            const index = args.indexOf('stdio')
            args.splice(index < 0 ? args.length : index, 0, '--effort', this.grokEffort(this.options.effort))
        }
        if (this.driver.kind === 'grok' && this.options.permissionPolicy === 'bypass') {
            const index = args.indexOf('stdio')
            args.splice(index < 0 ? args.length : index, 0, '--always-approve')
        }
        const child = this.driver.spawn(workspace, this.options, args)
        this.process = child
        this.captureStderr(child)
        child.once('error', (error) => this.onProcessFailure(error))
        child.once('exit', (code, signal) => {
            if (this.disposed || this.process !== child) return
            if (this.sink.state === 'canceled' || this.sink.state === 'completed') return
            this.onProcessFailure(
                new Error(
                    `ACP agent exited unexpectedly (${signal || code || 'unknown'})`
                )
            )
        })

        const app = acp
            .client({ name: 'nexus-agentd' })
            .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
                this.requestPermission(params)
            )
            .onRequest(acp.methods.client.elicitation.create, ({ params }) =>
                this.requestInput(params)
            )
            .onNotification(acp.methods.client.session.update, ({ params }) => {
                this.sessionUpdate(params)
            })
        if (this.driver.kind === 'gemini') {
            app.onRequest(acp.methods.client.fs.readTextFile, ({ params }) => {
                if (this.disposed || params.sessionId !== this.sink.acpSessionId) throw new Error('Unknown ACP session')
                return readAcpText(workspace, params.path, params.line, params.limit)
            })
            app.onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
                if (this.disposed || params.sessionId !== this.sink.acpSessionId) throw new Error('Unknown ACP session')
                if (this.options.permissionPolicy === 'deny') throw new Error('File write denied by session policy')
                const result = await writeAcpText(workspace, params.path, params.content)
                this.sink.emit('file_activity', { locations: [{ path: params.path }], operation: 'write' })
                return result
            })
        }
        const stream = acp.ndJsonStream(
            Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
            Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
        )
        this.connection = app.connect(stream)
        const initialize = await this.connection.agent.request(
            acp.methods.agent.initialize,
            {
                protocolVersion: acp.PROTOCOL_VERSION,
                clientCapabilities: {
                    ...(this.driver.kind === 'gemini' ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
                    elicitation: {
                        form: {},
                        url: {}
                    }
                },
                clientInfo: {
                    name: 'nexus-agentd',
                    version: '0.7.0'
                }
            }
        )
        if (this.disposed) throw new Error('ACP runtime is disposed')
        if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
            this.sink.emit('terminal_output', {
                stream: 'system',
                text: `ACP negotiated protocol ${initialize.protocolVersion}`
            })
        }
        this.promptCapabilities = initialize.agentCapabilities?.promptCapabilities || {}
        const configuredResume = this.driver.config?.resumeMethod || 'auto'
        this.resumeMethod = configuredResume === 'none' ? undefined : configuredResume === 'resume' || configuredResume === 'load'
            ? configuredResume : initialize.agentCapabilities?.sessionCapabilities?.resume ? 'resume'
            : initialize.agentCapabilities?.loadSession ? 'load' : undefined
        const nativeId = this.sink.acpSessionId
        if (nativeId && !this.resumeMethod) throw new Error('Agent does not support restoring its native session')
        this.restoring = Boolean(nativeId)
        const session = nativeId
            ? await this.connection.agent.request(this.resumeMethod === 'resume' ? acp.methods.agent.session.resume : acp.methods.agent.session.load,
                { cwd: workspace, sessionId: nativeId, mcpServers: [] })
            : await this.connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [],
                ...(this.driver.kind === 'grok' ? { _meta: { yoloMode: this.options.permissionPolicy === 'bypass',
                    ...(this.options.model ? { modelId: this.options.model } : {}),
                    ...(this.options.effort ? { reasoningEffort: this.grokEffort(this.options.effort) } : {}) } } : {}) })
        this.restoring = false
        if (this.disposed) throw new Error('ACP runtime is disposed')
        this.sink.setAcpSessionId(nativeId || String((session as acp.NewSessionResponse).sessionId))
        this.remember(session)
        await this.applySelection(this.options)
        this.lastActivityAt = Date.now()
        this.sink.setState('created')
    }

    view(): AgentRuntimeView {
        return { driver: this.driver.kind, status: this.suspended ? 'suspended' : this.isAvailable() ? 'ready' : 'stopped', resumable: Boolean(this.resumeMethod),
            options: structuredClone(this.options), configOptions: structuredClone(this.configOptions), modes: this.modes ? structuredClone(this.modes) : undefined,
            lastActivityAt: this.lastActivityAt }
    }

    private remember(value: { configOptions?: acp.SessionConfigOption[] | null; modes?: acp.SessionModeState | null }) {
        if (value.configOptions) this.configOptions = value.configOptions
        if (value.modes) this.modes = value.modes
    }

    async configure(options: AgentSessionOptions) {
        if (this.prompting || this.pending || this.pendingInput) throw new Error('Cannot configure an active turn')
        const update = parseSessionOptions(options)
        if (this.suspended) await this.wake()
        if (!this.isAvailable()) throw new Error('Agent runtime is unavailable')
        if (this.driver.kind === 'cursor' && update.model && update.model !== this.options.model) throw new Error('Cursor model selection requires a new session')
        if (this.driver.kind === 'grok' && update.effort && update.effort !== this.options.effort) throw new Error('Grok effort selection requires a new session')
        try { await this.applySelection(update) } catch (error) {
            for (const category of ['model', 'effort', 'mode'] as const) {
                const current = findOption(this.configOptions, category)?.currentValue
                if (typeof current === 'string') this.options[category] = current
            }
            this.sink.emit('session_options', this.view())
            if (error instanceof PromptTimeoutError) {
                this.sink.setState('failed', error.message)
                await this.dispose()
            }
            throw error
        }
        this.options = { ...this.options, ...update, configOptions: { ...this.options.configOptions, ...update.configOptions } }
        this.sink.emit('session_options', this.view())
    }

    private async setOption(option: acp.SessionConfigOption, requested: string | boolean) {
        const value = selectionValue(this.driver.kind || '', option, requested)
        if (option.currentValue === value) return
        const response = await withTimeout(this.connection!.agent.request(acp.methods.agent.session.setConfigOption,
            { sessionId: this.requireSessionId(), configId: option.id, value } as acp.SetSessionConfigOptionRequest), this.startupTimeoutMs, 'ACP configuration timed out')
        this.remember(response)
    }

    private async applySelection(options: AgentSessionOptions) {
        for (const category of ['model', 'effort', 'mode'] as const) {
            const requested = options[category]
            if (!requested) continue
            if (this.driver.kind === 'cursor' && category === 'model' || this.driver.kind === 'grok' && category === 'effort') continue
            const option = findOption(this.configOptions, category)
            if (option) await this.setOption(option, requested)
            else if (category === 'model' && this.driver.kind === 'grok') {
                const params = { sessionId: this.requireSessionId(), modelId: requested,
                    ...((options.effort || this.options.effort) ? { _meta: { reasoningEffort: this.grokEffort(options.effort || this.options.effort!) } } : {}) }
                try { await withTimeout(this.connection!.agent.request('session/setModel', params), this.startupTimeoutMs, 'Grok model selection timed out') }
                catch (error) {
                    if ((error as { code?: number }).code !== -32601) throw error
                    await withTimeout(this.connection!.agent.request('session/set_model', params), this.startupTimeoutMs, 'Grok model selection timed out')
                }
            }
            else if (category === 'model' && this.driver.kind === 'gemini') {
                await withTimeout(this.connection!.agent.request('session/set_model', { sessionId: this.requireSessionId(), modelId: requested }), this.startupTimeoutMs, 'Gemini model selection timed out')
            }
            else if (category === 'mode') await this.setMode(requested)
            else throw new Error(`Agent does not advertise ${category} selection`)
            this.options[category] = requested
        }
        for (const [id, value] of Object.entries(options.configOptions || {})) {
            const option = this.configOptions.find(item => item.id === id)
            if (!option) throw new Error(`Agent does not advertise config option: ${id}`)
            await this.setOption(option, value)
            this.options.configOptions = { ...this.options.configOptions, [id]: value }
        }
        if (options.permissionPolicy === 'bypass') {
            const permissionOption = this.configOptions.find(item => item.id === 'permissionMode')
            const mode = unattendedMode(this.driver.kind || '')
            if (permissionOption) await this.setOption(permissionOption, 'bypassPermissions')
            else if (mode && (findOption(this.configOptions, 'mode') || this.modes?.availableModes.some(item => item.id === mode))) {
                const option = findOption(this.configOptions, 'mode')
                if (option) await this.setOption(option, mode)
                else await this.setMode(mode)
            }
        } else if (options.permissionPolicy && this.options.permissionPolicy === 'bypass') {
            throw new Error('Leaving native bypass mode requires a new session')
        }
    }

    private grokEffort(effort: string) { return effort === 'max' ? 'xhigh' : effort === 'off' ? 'none' : effort }

    private async setMode(mode: string) {
        if (!this.modes?.availableModes.some(item => item.id === mode)) throw new Error(`Unsupported session mode: ${mode}`)
        await withTimeout(this.connection!.agent.request(acp.methods.agent.session.setMode, { sessionId: this.requireSessionId(), modeId: mode }), this.startupTimeoutMs, 'ACP mode selection timed out')
        this.modes.currentModeId = mode
    }

    async suspend() {
        if (this.prompting || this.pending || this.pendingInput || !this.resumeMethod || !this.isAvailable() || this.suspended) return false
        await this.dispose()
        this.suspended = true
        this.sink.emit('runtime_state', this.view())
        return true
    }

    private async wake() {
        if (!this.suspended) return
        if (this.allowedRoots.length) await (await WorkspacePolicy.create([...this.allowedRoots])).resolve(this.workspace!)
        this.suspended = false
        this.disposed = false
        this.disposal = undefined
        await this.start(this.workspace!)
        this.sink.emit('runtime_state', this.view())
    }

    async prompt(message: string, attachments: AgentdInputAttachment[] = []) {
        if (this.suspended) await this.wake()
        if (this.disposed) throw new Error('ACP runtime is disposed')
        if (!this.connection) throw new Error('ACP runtime is not connected')
        if (this.prompting) throw new Error('ACP session is already processing a prompt')
        const sessionId = this.requireSessionId()
        this.prompting = true
        this.promptOutput = ''
        this.sink.clearPending()
        this.sink.setState('running')
        try {
            this.lastActivityAt = Date.now()
            const response = await this.watchTurn(
                this.connection.agent.request(acp.methods.agent.session.prompt, {
                    sessionId,
                    prompt: await this.promptBlocks(message, attachments)
                }),
            )
            if (this.sink.state === 'canceled' || this.sink.state === 'failed') {
                return
            }
            switch (response.stopReason) {
                case 'end_turn':
                    await this.captureMediaMarkers()
                    this.sink.completeTurn({
                        source: 'acp_prompt_response',
                        stopReason: response.stopReason
                    })
                    break
                case 'cancelled':
                    this.sink.setState('canceled')
                    break
                case 'refusal':
                    this.sink.setState('failed', 'ACP agent refused the prompt')
                    break
                default:
                    this.sink.setState(
                        'failed',
                        `ACP turn stopped before completion: ${response.stopReason}`
                    )
            }
        } catch (error) {
            if (this.sink.state !== 'canceled') {
                this.sink.setState(
                    'failed',
                    error instanceof Error ? error.message : String(error)
                )
            }
            if (error instanceof PromptTimeoutError) await this.dispose()
        } finally {
            this.prompting = false
        }
    }

    private watchTurn<T>(promise: Promise<T>): Promise<T> {
        let elapsed = 0
        let previous = Date.now()
        const stall = this.driver.config?.stallTimeoutMs ?? 10 * 60_000
        let timer: NodeJS.Timeout
        const deadline = new Promise<never>((_, reject) => {
            timer = setInterval(() => {
                const now = Date.now()
                if (!this.pending && !this.pendingInput) {
                    elapsed += now - previous
                    if (elapsed >= this.promptTimeoutMs) reject(new PromptTimeoutError('ACP task deadline exceeded'))
                    else if (stall > 0 && now - this.lastActivityAt >= stall) reject(new PromptTimeoutError('ACP stalled: no protocol progress'))
                } else this.lastActivityAt = now
                previous = now
            }, 250)
            timer.unref?.()
        })
        return Promise.race([promise, deadline]).finally(() => clearInterval(timer))
    }

    async respondPending(
        input: AgentdPendingResponse | string,
        _attachments: AgentdInputAttachment[] = []
    ) {
        const response =
            typeof input === 'string'
                ? {
                      requestId:
                          this.pendingInput?.request.id ??
                          this.pending?.request.id ??
                          '',
                      message: input
                  }
                : input
        if (this.pendingInput) {
            if (response.requestId !== this.pendingInput.request.id) {
                throw new Error(`ACP pending request no longer matches: ${response.requestId}`)
            }
            this.finishInput(response.message ?? response.optionId ?? '', response.action)
            return
        }
        const pending = this.pending
        if (!pending) throw new Error('ACP session is not waiting for input')
        if (response.requestId !== pending.request.id) {
            throw new Error(`ACP pending request no longer matches: ${response.requestId}`)
        }
        const options = pending.request.options || []
        if (response.action === 'cancel' || response.action === 'decline') {
            this.finishPermission({ outcome: { outcome: 'cancelled' } })
            return
        }
        // Protocol IDs are opaque: never interpret a numeric ID as an index or
        // fold its case into a different (possibly permanent) permission.
        if (response.optionId !== undefined) {
            const option = options.find((item) => item.id === response.optionId)
            if (!option) throw new Error('Permission optionId does not match an offered option')
            this.finishPermission({ outcome: { outcome: 'selected', optionId: option.id } })
            return
        }
        if (response.action === 'accept' && !response.optionId) {
            const option = options.find((item) => item.kind === 'allow_once')
            if (!option) {
                throw new Error('Permission request requires an explicit optionId; no allow_once option is available')
            }
            this.finishPermission({
                outcome: { outcome: 'selected', optionId: option.id }
            })
            return
        }
        const normalized = (response.optionId ?? response.message ?? '')
            .trim()
            .toLowerCase()
        if (
            ['cancel', 'deny', 'reject', '拒绝', '取消', '不同意'].includes(
                normalized
            )
        ) {
            this.finishPermission({ outcome: { outcome: 'cancelled' } })
            return
        }
        const numeric = Number(normalized)
        const option = Number.isInteger(numeric) && numeric >= 1
            ? options[numeric - 1]
            : options.find(
                  (item) =>
                      item.id.toLowerCase() === normalized ||
                      item.name.toLowerCase() === normalized
              )
        if (!option) {
            throw new Error(
                `Permission answer must be an option id/name or index: ${options
                    .map((item, index) => `${index + 1}. ${item.name} (${item.id})`)
                    .join('; ')}`
            )
        }
        this.finishPermission({
            outcome: {
                outcome: 'selected',
                optionId: option.id
            }
        })
    }

    async cancel() {
        if (this.pending) {
            this.finishPermission({ outcome: { outcome: 'cancelled' } })
        }
        if (this.pendingInput) {
            this.finishInput('cancel')
        }
        this.sink.setState('canceled')
        if (this.connection) {
            try {
                await withTimeout(this.connection.agent.notify(acp.methods.agent.session.cancel, {
                    sessionId: this.requireSessionId()
                }), 2_000, 'ACP cancellation notification timed out')
            } catch (error) {
                this.sink.emit('terminal_output', {
                    stream: 'system',
                    text: `ACP cancellation notification failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                })
            }
        }
        this.sink.setState('canceled')
        await this.dispose()
    }

    async dispose() {
        this.suspended = false
        if (this.disposed) return this.disposal
        this.disposed = true
        this.disposal = this.closeResources()
        return this.disposal
    }

    private async closeResources() {
        if (this.pending) {
            clearTimeout(this.pending.timer)
            this.pending.reject(new Error('ACP runtime disposed'))
            this.pending = undefined
        }
        if (this.pendingInput) {
            clearTimeout(this.pendingInput.timer)
            this.pendingInput.resolve({ action: 'cancel' })
            this.pendingInput = undefined
        }
        const connection = this.connection
        this.connection = undefined
        try { connection?.close() } catch (error) {
            this.sink.emit('terminal_output', {
                stream: 'system', text: `ACP connection close failed: ${error instanceof Error ? error.message : String(error)}`
            })
        }
        const child = this.process
        this.process = undefined
        if (child) {
            await terminateProcessTree(child, {
                ownsProcessGroup: this.driver.ownsProcessGroup
            })
        }
        if (this.inputDirectory) {
            await rm(this.inputDirectory, { recursive: true, force: true }).catch(() => undefined)
            this.inputDirectory = undefined
        }
    }

    isAvailable() {
        return this.suspended || !this.disposed && Boolean(this.connection) &&
            (!this.process || (this.process.exitCode === null && this.process.signalCode === null))
    }

    private requestPermission(
        params: acp.RequestPermissionRequest
    ): Promise<acp.RequestPermissionResponse> | acp.RequestPermissionResponse {
        this.lastActivityAt = Date.now()
        const policy = this.options.permissionPolicy || this.driver.permissionPolicy
        if (policy === 'deny') {
            const reject = params.options.find((option) =>
                option.kind.startsWith('reject')
            )
            return reject
                ? {
                      outcome: {
                          outcome: 'selected',
                          optionId: reject.optionId
                      }
                  }
                : { outcome: { outcome: 'cancelled' } }
        }
        if (policy === 'allow' || policy === 'auto' || policy === 'bypass') {
            const allow =
                params.options.find(
                    (option) => option.kind.toLowerCase() === 'allow_once'
                ) || (policy !== 'allow' ? params.options.find(option => option.kind === 'allow_always') : undefined)
            this.sink.emit('permission_decision', { policy, toolCallId: params.toolCall.toolCallId, optionId: allow?.optionId, outcome: allow ? 'allowed' : 'canceled' })
            return allow
                ? {
                      outcome: {
                          outcome: 'selected',
                          optionId: allow.optionId
                      }
                  }
                : { outcome: { outcome: 'cancelled' } }
        }
        if (this.pending) {
            return { outcome: { outcome: 'cancelled' } }
        }
        const request: AgentdPendingRequest = {
            id: randomUUID(),
            kind: 'permission',
            prompt:
                params.toolCall.title ||
                `Permission requested for tool ${params.toolCall.toolCallId}`,
            inputType: 'confirmation',
            step: params.toolCall.toolCallId
                ? `tool:${params.toolCall.toolCallId}`
                : undefined,
            options: params.options.map((option) => ({
                id: option.optionId,
                name: option.name,
                kind: option.kind
            })),
            metadata: permissionMetadata(params)
        }
        this.sink.setPending(request)
        return new Promise<acp.RequestPermissionResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending?.request.id !== request.id) return
                this.pending = undefined
                this.sink.clearPending()
                this.sink.setState('failed', 'ACP permission request timed out')
                resolve({ outcome: { outcome: 'cancelled' } })
                void this.dispose().catch(error => this.sink.emit('terminal_output', { stream: 'system', text: `Cleanup failed: ${String(error)}` }))
            }, this.driver.permissionTimeoutMs)
            this.pending = { request, resolve, reject, timer }
        })
    }

    private finishPermission(response: acp.RequestPermissionResponse) {
        const pending = this.pending
        if (!pending) return
        this.pending = undefined
        clearTimeout(pending.timer)
        this.sink.clearPending()
        this.sink.setState('running')
        pending.resolve(response)
    }

    private requestInput(
        params: acp.CreateElicitationRequest
    ): Promise<acp.CreateElicitationResponse> {
        if (this.pending || this.pendingInput) {
            return Promise.resolve({ action: 'cancel' })
        }
        const request: AgentdPendingRequest = {
            id: randomUUID(),
            kind: 'input',
            prompt:
                params.mode === 'url'
                    ? `${params.message}\n${params.url}`
                    : params.message,
            options: elicitationOptions(params),
            ...elicitationClassification(params)
        }
        this.sink.setPending(request)
        return new Promise<acp.CreateElicitationResponse>((resolve) => {
            const timer = setTimeout(() => {
                if (this.pendingInput?.request.id !== request.id) return
                this.pendingInput = undefined
                this.sink.clearPending()
                this.sink.setState('failed', 'ACP input request timed out')
                resolve({ action: 'cancel' })
                void this.dispose().catch(error => this.sink.emit('terminal_output', { stream: 'system', text: `Cleanup failed: ${String(error)}` }))
            }, this.driver.permissionTimeoutMs)
            this.pendingInput = { request, params, resolve, timer }
        })
    }

    private finishInput(
        message: string,
        requestedAction?: AgentdPendingResponse['action']
    ) {
        const pending = this.pendingInput
        if (!pending) return
        const normalized = message.trim().toLowerCase()
        let response: acp.CreateElicitationResponse
        if (requestedAction === 'cancel' || ['cancel', '取消'].includes(normalized)) {
            response = { action: 'cancel' }
        } else if (
            requestedAction === 'decline' ||
            ['decline', '拒绝', '不同意'].includes(normalized)
        ) {
            response = { action: 'decline' }
        } else if (!isFormElicitation(pending.params)) {
            response = { action: 'accept' }
        } else {
            response = {
                action: 'accept',
                content: elicitationContent(pending.params, message)
            }
        }
        this.pendingInput = undefined
        clearTimeout(pending.timer)
        this.sink.clearPending()
        this.sink.setState('running')
        pending.resolve(response)
    }

    private sessionUpdate(params: acp.SessionNotification) {
        this.lastActivityAt = Date.now()
        const update = params.update
        if (update.sessionUpdate === 'config_option_update') {
            this.configOptions = update.configOptions
            this.sink.emit('session_options', this.view())
            return
        }
        if (update.sessionUpdate === 'current_mode_update') {
            if (this.modes) this.modes.currentModeId = update.currentModeId
            return
        }
        if (this.restoring) return
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') {
                    this.promptOutput += update.content.text
                    this.sink.appendOutput(update.content.text)
                    this.sink.emit('assistant_chunk', {
                        messageId: update.messageId,
                        content: update.content
                    })
                } else {
                    this.captureArtifact(
                        update.content,
                        `message:${String(update.messageId || 'assistant')}:0`
                    )
                }
                break
            case 'agent_thought_chunk':
                this.sink.emit('thought_chunk', update)
                break
            case 'tool_call':
                this.captureToolArtifacts(
                    String(update.toolCallId),
                    update.content,
                    update.title
                )
                this.sink.emit('tool_call', update)
                if (update.locations?.length) {
                    this.sink.emit('file_activity', {
                        toolCallId: update.toolCallId,
                        locations: update.locations
                    })
                }
                break
            case 'tool_call_update':
                this.captureToolArtifacts(
                    String(update.toolCallId),
                    update.content,
                    update.title || update.name
                )
                this.sink.emit('tool_update', update)
                if (update.locations?.length) {
                    this.sink.emit('file_activity', {
                        toolCallId: update.toolCallId,
                        locations: update.locations
                    })
                }
                break
            case 'plan':
            case 'plan_update':
            case 'plan_removed':
                this.sink.emit('plan', update)
                break
            default:
                break
        }
    }

    private captureToolArtifacts(
        toolCallId: string,
        content: acp.ToolCallContent[] | null | undefined,
        hint?: string | null
    ) {
        content?.forEach((item, index) => {
            if (item.type !== 'content') return
            this.captureArtifact(
                item.content,
                `tool:${toolCallId}:${index}`,
                hint || undefined
            )
        })
    }

    private captureArtifact(
        content: acp.ContentBlock,
        id: string,
        hint?: string
    ) {
        const artifact = artifactFromContent(content, id, hint)
        if (artifact) this.sink.addArtifact(artifact)
    }

    private async captureMediaMarkers() {
        const markers = mediaMarkers(this.promptOutput)
        if (!markers.length) return
        this.sink.replaceOutput(withoutMediaMarkers(this.promptOutput))
        const roots = this.allowedRoots.length
            ? this.allowedRoots
            : this.workspace
              ? [this.workspace]
              : []
        const unique = Array.from(new Set(markers))
        const accepted = unique.slice(0, MAX_MEDIA_MARKER_ARTIFACTS)
        const ignored = unique.length - accepted.length
        if (ignored > 0) {
            this.sink.emit('terminal_output', {
                stream: 'system',
                text: `Ignored ${ignored} MEDIA marker(s); at most ${MAX_MEDIA_MARKER_ARTIFACTS} artifacts can be attached per turn.`
            })
        }
        for (const marker of accepted) {
            try {
                const artifact = await artifactFromMediaMarker(
                    marker,
                    `media:${randomUUID()}`,
                    roots
                )
                this.sink.addArtifact(artifact)
                this.sink.emit('artifact', artifact)
            } catch (error) {
                this.sink.emit('terminal_output', {
                    stream: 'system',
                    text: `Could not attach MEDIA artifact ${safeMarkerName(marker)}: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                })
            }
        }
    }

    private captureStderr(child: ChildProcessWithoutNullStreams) {
        // Explicit UTF-8 streaming decoder: `String(chunk)` on a Buffer uses the
        // default binary encoding, which mangles multi-byte characters if a
        // chunk boundary splits a rune. `TextDecoder` with `stream: true`
        // preserves the split byte between calls.
        const decoder = new TextDecoder('utf-8')
        let buffer = ''
        let flushed = false
        const emit = (text: string) => {
            if (!text) return
            for (let offset = 0; offset < text.length; offset += this.maxStderrChunkChars) {
                this.sink.emit('terminal_output', {
                    stream: 'stderr',
                    text: text.slice(offset, offset + this.maxStderrChunkChars)
                })
            }
        }
        const drain = (flush = false) => {
            const lines = buffer.split(/\r?\n/)
            buffer = lines.pop() || ''
            for (const line of lines) emit(line)
            while (buffer.length >= this.maxStderrChunkChars) {
                emit(buffer.slice(0, this.maxStderrChunkChars))
                buffer = buffer.slice(this.maxStderrChunkChars)
            }
            if (flush && buffer) {
                emit(buffer)
                buffer = ''
            }
        }
        const flush = () => {
            if (flushed) return
            flushed = true
            buffer += decoder.decode()
            drain(true)
        }
        child.stderr.on('data', (chunk) => {
            const bytes =
                chunk instanceof Uint8Array
                    ? chunk
                    : Buffer.isBuffer(chunk)
                      ? chunk
                      : Buffer.from(String(chunk))
            buffer += decoder.decode(bytes, { stream: true })
            drain()
        })
        child.stderr.once('end', flush)
        child.stderr.once('close', flush)
    }

    private onProcessFailure(error: unknown) {
        if (this.disposed) return
        this.sink.setState(
            'failed',
            error instanceof Error ? error.message : String(error)
        )
    }

    private requireSessionId() {
        const value = this.sink.acpSessionId
        if (typeof value !== 'string' || !value) {
            throw new Error('ACP session has not been initialized')
        }
        return value
    }

    private async promptBlocks(message: string, attachments: AgentdInputAttachment[]) {
        const blocks: acp.ContentBlock[] = [
            { type: 'text', text: message },
            { type: 'text', text: TURN_COMPLETION_CONTRACT }
        ]
        for (const attachment of attachments) {
            const mediaType = attachment.mediaType || 'application/octet-stream'
            const data = attachment.bytes.toString('base64')
            if (mediaType.startsWith('image/') && this.promptCapabilities.image) {
                blocks.push({ type: 'image', data, mimeType: mediaType })
                continue
            }
            if (mediaType.startsWith('audio/') && this.promptCapabilities.audio) {
                blocks.push({ type: 'audio', data, mimeType: mediaType })
                continue
            }
            if (this.promptCapabilities.embeddedContext) {
                blocks.push({
                    type: 'resource',
                    resource: {
                        uri: `nexus-input://${this.sink.id}/${encodeURIComponent(attachment.name)}`,
                        blob: data,
                        mimeType: mediaType
                    }
                })
                continue
            }
            blocks.push(await this.writeResourceLink(attachment, mediaType))
        }
        return blocks
    }

    private async writeResourceLink(attachment: AgentdInputAttachment, mediaType: string) {
        const directory = this.inputDirectory || path.join(process.cwd(), '.nexus-inputs', this.sink.id)
        this.inputDirectory = directory
        await mkdir(directory, { recursive: true })
        const filename = `${attachment.id}-${safeFilename(attachment.name) || 'attachment'}`
        const filePath = path.join(directory, filename)
        await writeFile(filePath, attachment.bytes, { mode: 0o600 })
        return {
            type: 'resource_link' as const,
            name: attachment.name,
            uri: pathToFileURL(filePath).toString(),
            mimeType: mediaType,
            size: attachment.bytes.length
        }
    }
}

class PromptTimeoutError extends Error {}

function safeFilename(value: string) {
    return String(value || '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .trim()
        .slice(0, 180)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PromptTimeoutError(message)), timeoutMs)
        timer.unref?.()
    })
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer)
    })
}

function artifactFromContent(
    content: acp.ContentBlock,
    id: string,
    hint?: string
): AgentdArtifact | undefined {
    switch (content.type) {
        case 'image': {
            const filename = artifactFilename(
                content.uri,
                hint,
                `image-${artifactIndex(id)}`,
                content.mimeType
            )
            return {
                id,
                name: filename,
                filename,
                mediaType: content.mimeType,
                bytesBase64: content.data,
                url: usableUrl(content.uri),
                metadata: artifactMetadata(id, content.uri, content.annotations)
            }
        }
        case 'audio': {
            const filename = artifactFilename(
                undefined,
                hint,
                `audio-${artifactIndex(id)}`,
                content.mimeType
            )
            return {
                id,
                name: filename,
                filename,
                mediaType: content.mimeType,
                bytesBase64: content.data,
                metadata: artifactMetadata(id, undefined, content.annotations)
            }
        }
        case 'resource_link': {
            const filename = artifactFilename(
                content.uri,
                content.name || hint,
                `resource-${artifactIndex(id)}`,
                content.mimeType || undefined
            )
            return {
                id,
                name: content.title || content.name || filename,
                description: content.description || undefined,
                filename,
                mediaType: content.mimeType || undefined,
                url: content.uri,
                metadata: artifactMetadata(
                    id,
                    content.uri,
                    content.annotations,
                    content.size ?? undefined
                )
            }
        }
        case 'resource': {
            const resource = content.resource
            const filename = artifactFilename(
                resource.uri,
                hint,
                `resource-${artifactIndex(id)}`,
                resource.mimeType || undefined
            )
            return {
                id,
                name: filename,
                filename,
                mediaType: resource.mimeType || undefined,
                text: 'text' in resource ? resource.text : undefined,
                bytesBase64: 'blob' in resource ? resource.blob : undefined,
                url: usableUrl(resource.uri),
                metadata: artifactMetadata(id, resource.uri, content.annotations)
            }
        }
        default:
            return undefined
    }
}

function artifactMetadata(
    sourceId: string,
    uri?: string | null,
    annotations?: acp.Annotations | null,
    size?: number
) {
    return {
        sourceId,
        ...(uri ? { uri } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(annotations ? { annotations } : {})
    }
}

function artifactFilename(
    uri: string | null | undefined,
    hint: string | null | undefined,
    fallback: string,
    mediaType?: string
) {
    return (
        filenameFromValue(uri) ||
        filenameFromValue(hint) ||
        `${fallback}${extensionForMediaType(mediaType)}`
    )
}

function filenameFromValue(value: string | null | undefined) {
    if (!value) return undefined
    let candidate = value
    try {
        candidate = new URL(value).pathname
    } catch {}
    candidate = candidate.split(/[\\/]/).pop() || candidate
    candidate = candidate.split(/[?#]/, 1)[0].trim()
    const filename = candidate.match(/([^\s]+\.[A-Za-z0-9]{1,16})$/)?.[1]
    if (!filename) return undefined
    try {
        return decodeURIComponent(filename)
    } catch {
        return filename
    }
}

function usableUrl(value: string | null | undefined) {
    return value && /^(?:https?|file):/i.test(value) ? value : undefined
}

function mediaMarkers(output: string) {
    return output
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*MEDIA:\s*(.+?)\s*$/i)?.[1]?.trim())
        .filter((value): value is string => Boolean(value))
}

function withoutMediaMarkers(output: string) {
    return output
        .split(/\r?\n/)
        .filter((line) => !/^\s*MEDIA:\s*(.+?)\s*$/i.test(line))
        .join('\n')
        .trim()
}

async function artifactFromMediaMarker(
    marker: string,
    id: string,
    roots: readonly string[]
): Promise<AgentdArtifact> {
    if (/^https?:\/\//i.test(marker)) {
        const filename = artifactFilename(marker, undefined, 'resource', undefined)
        return {
            id,
            name: filename,
            filename,
            url: marker,
            metadata: { source: 'acp_media_marker' }
        }
    }

    const localPath = marker.startsWith('file:') ? fileURLToPath(marker) : marker
    // Stat only: the artifact store copies the file from disk, which keeps a
    // multi-gigabyte deliverable out of the base64/JSON-RPC path.
    const file = await statContainedFile(roots, localPath, {
        maxBytes: MAX_MEDIA_MARKER_FILE_BYTES
    })
    const stats = await stat(file.path)
    return {
        id,
        name: file.filename,
        filename: file.filename,
        mediaType: mediaTypeForPath(file.filename),
        description:
            'Payload is stored by the gateway; download it from ' +
            'GET /v1/runs/{runId}/artifacts/{artifactId}.',
        sourcePath: file.path,
        metadata: {
            source: 'acp_media_marker',
            size: file.size,
            mtimeMs: stats.mtimeMs
        }
    }
}

function safeMarkerName(marker: string) {
    try {
        return path.basename(marker.startsWith('file:') ? fileURLToPath(marker) : marker)
    } catch {
        return 'declared artifact'
    }
}

function mediaTypeForPath(value: string) {
    switch (path.extname(value).toLowerCase()) {
        case '.pptx':
            return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        case '.docx':
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        case '.xlsx':
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        case '.pdf':
            return 'application/pdf'
        case '.png':
            return 'image/png'
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg'
        case '.gif':
            return 'image/gif'
        case '.webp':
            return 'image/webp'
        case '.mp3':
            return 'audio/mpeg'
        case '.wav':
            return 'audio/wav'
        case '.mp4':
            return 'video/mp4'
        default:
            return 'application/octet-stream'
    }
}

function artifactIndex(id: string) {
    return id.split(':').pop() || 'output'
}

function extensionForMediaType(mediaType?: string) {
    const extensions: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'audio/mpeg': '.mp3',
        'audio/wav': '.wav',
        'audio/ogg': '.ogg',
        'application/pdf': '.pdf'
    }
    return mediaType ? extensions[mediaType.toLowerCase()] || '' : ''
}

function elicitationOptions(params: acp.CreateElicitationRequest) {
    if (!isFormElicitation(params)) return undefined
    const properties = params.requestedSchema.properties || {}
    if (Object.keys(properties).length !== 1) return undefined
    const schema = Object.values(properties)[0]
    if (schema.type !== 'string') return undefined
    const oneOf = Array.isArray((schema as any).oneOf)
        ? ((schema as any).oneOf as Array<{ const: string; title: string }>)
        : []
    if (oneOf.length) {
        return oneOf.map((option) => ({
            id: String(option.const),
            name: String(option.title),
            kind: 'input'
        }))
    }
    const values = Array.isArray((schema as any).enum)
        ? ((schema as any).enum as unknown[])
        : []
    return values.map((value) => ({
        id: String(value),
        name: String(value),
        kind: 'input'
    }))
}

function elicitationContent(
    params: FormElicitation,
    message: string
) {
    try {
        const parsed = JSON.parse(message) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, acp.ElicitationContentValue>
        }
    } catch {}
    const properties = params.requestedSchema.properties || {}
    const entries = Object.entries(properties)
    if (entries.length !== 1) {
        throw new Error('Structured ACP input requires a JSON object')
    }
    const [key, schema] = entries[0]
    if (schema.type === 'boolean') {
        const value = message.trim().toLowerCase()
        if (['true', 'yes', '1', '是'].includes(value)) return { [key]: true }
        if (['false', 'no', '0', '否'].includes(value)) return { [key]: false }
        throw new Error('Boolean ACP input must be true/false or yes/no')
    }
    if (schema.type === 'number' || schema.type === 'integer') {
        const value = Number(message)
        if (!Number.isFinite(value)) throw new Error('ACP input must be a number')
        return { [key]: schema.type === 'integer' ? Math.trunc(value) : value }
    }
    if (schema.type === 'array') {
        return {
            [key]: message
                .split(/[,，\n]/)
                .map((item) => item.trim())
                .filter(Boolean)
        }
    }
    return { [key]: message }
}

function isFormElicitation(
    params: acp.CreateElicitationRequest
): params is FormElicitation {
    return (
        params.mode === 'form' &&
        Boolean(
            (params as Record<string, unknown>).requestedSchema &&
                typeof (params as Record<string, unknown>).requestedSchema ===
                    'object'
        )
    )
}

/**
 * Derive Agent Nexus semantic classification (inputType / step / metadata) from
 * an ACP elicitation request. This is a best-effort projection: we look at the
 * elicitation mode, the requested schema shape and well-known field names to
 * decide whether the pending request is a plain text prompt, a choice, a
 * yes/no confirmation, or a payment URL flow.
 */
function elicitationClassification(
    params: acp.CreateElicitationRequest
): Pick<AgentdPendingRequest, 'inputType' | 'step' | 'metadata'> {
    const metadata: Record<string, unknown> = {}
    let inputType: AgentdPendingRequest['inputType'] = 'unknown'
    let step: string | undefined
    if (params.mode === 'url') {
        const url = String((params as { url?: unknown }).url || '').trim()
        if (url) {
            metadata.paymentUrl = url
            metadata.url = url
        }
        inputType = /pay|支付|invoice|order/i.test(
            `${params.message || ''} ${url}`
        )
            ? 'payment'
            : 'text'
        step = 'url'
    } else if (isFormElicitation(params)) {
        const properties = params.requestedSchema.properties || {}
        const entries = Object.entries(properties)
        step = entries.length === 1 ? entries[0][0] : 'form'
        if (entries.length === 1) {
            const [, schema] = entries[0]
            if (schema.type === 'boolean') inputType = 'confirmation'
            else if (
                Array.isArray((schema as { oneOf?: unknown }).oneOf) ||
                Array.isArray((schema as { enum?: unknown[] }).enum)
            ) {
                inputType = 'choice'
            } else {
                inputType = 'text'
            }
        } else {
            inputType = 'text'
        }
        const paymentUrl = firstStringFromSchema(properties, [
            'paymentUrl',
            'payUrl',
            'payment_url',
            'checkoutUrl'
        ])
        if (paymentUrl) {
            metadata.paymentUrl = paymentUrl
            inputType = 'payment'
        }
    } else {
        inputType = 'text'
    }
    return {
        inputType,
        ...(step ? { step } : {}),
        ...(Object.keys(metadata).length ? { metadata } : {})
    }
}

function permissionMetadata(
    params: acp.RequestPermissionRequest
): Record<string, unknown> | undefined {
    const metadata: Record<string, unknown> = {}
    const call = params.toolCall as { toolCallId?: unknown; name?: unknown; title?: unknown }
    if (typeof call?.toolCallId === 'string' && call.toolCallId) {
        metadata.toolCallId = call.toolCallId
    }
    if (typeof call?.name === 'string' && call.name) {
        metadata.tool = call.name
    }
    return Object.keys(metadata).length ? metadata : undefined
}

function firstStringFromSchema(
    properties: Record<string, unknown>,
    candidates: string[]
) {
    for (const key of candidates) {
        const schema = properties[key] as
            | { const?: unknown; default?: unknown }
            | undefined
        if (!schema) continue
        const value =
            (typeof schema.const === 'string' && schema.const) ||
            (typeof schema.default === 'string' && schema.default) ||
            ''
        if (value) return value
    }
    return undefined
}
