import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import * as acp from '@agentclientprotocol/sdk'
import type { AgentDriver } from '../drivers/index.js'
import type { AcpSessionSink } from '../session-contract.js'
import type { AgentdArtifact, AgentdPendingRequest } from '../types.js'

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

export class AcpProcessRuntime {
    private process?: ChildProcessWithoutNullStreams
    private connection?: acp.ClientConnection
    private pending?: PendingPermission
    private pendingInput?: PendingInput
    private disposed = false
    private prompting = false
    private readonly maxStderrChunkChars: number

    constructor(
        private readonly driver: AgentDriver,
        private readonly sink: AcpSessionSink,
        maxStderrChunkChars = 16 * 1024
    ) {
        const limit = Number.isFinite(maxStderrChunkChars)
            ? Math.floor(maxStderrChunkChars)
            : 16 * 1024
        this.maxStderrChunkChars = Math.max(1, Math.min(16 * 1024, limit))
    }

    async start(workspace: string) {
        if (this.process) throw new Error('ACP runtime is already started')
        const child = this.driver.spawn(workspace)
        this.process = child
        this.captureStderr(child)
        child.once('error', (error) => this.onProcessFailure(error))
        child.once('exit', (code, signal) => {
            if (this.disposed) return
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
                    elicitation: {
                        form: {},
                        url: {}
                    }
                },
                clientInfo: {
                    name: 'nexus-agentd',
                    version: '0.1.4'
                }
            }
        )
        if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
            this.sink.emit('terminal_output', {
                stream: 'system',
                text: `ACP negotiated protocol ${initialize.protocolVersion}`
            })
        }
        const session = await this.connection.agent.request(
            acp.methods.agent.session.new,
            {
                cwd: workspace,
                mcpServers: []
            }
        )
        this.sink.setAcpSessionId(String(session.sessionId))
        this.sink.setState('created')
    }

    async prompt(message: string) {
        if (!this.connection) throw new Error('ACP runtime is not connected')
        if (this.prompting) throw new Error('ACP session is already processing a prompt')
        const sessionId = this.requireSessionId()
        this.prompting = true
        this.sink.clearPending()
        this.sink.setState('running')
        try {
            const response = await this.connection.agent.request(
                acp.methods.agent.session.prompt,
                {
                    sessionId,
                    prompt: [{ type: 'text', text: message }]
                }
            )
            if (this.sink.state === 'canceled' || this.sink.state === 'failed') {
                return
            }
            if (response.stopReason === 'cancelled') {
                this.sink.setState('canceled')
            } else if (response.stopReason === 'refusal') {
                this.sink.setState('failed', 'ACP agent refused the prompt')
            } else {
                this.sink.setState('completed')
            }
        } catch (error) {
            if (this.sink.state !== 'canceled') {
                this.sink.setState(
                    'failed',
                    error instanceof Error ? error.message : String(error)
                )
            }
        } finally {
            this.prompting = false
        }
    }

    async respondPending(message: string) {
        if (this.pendingInput) {
            this.finishInput(message)
            return
        }
        const pending = this.pending
        if (!pending) throw new Error('ACP session is not waiting for input')
        const normalized = message.trim().toLowerCase()
        const options = pending.request.options || []
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
        if (this.connection && this.sink.state !== 'canceled') {
            try {
                await this.connection.agent.notify(acp.methods.agent.session.cancel, {
                    sessionId: this.requireSessionId()
                })
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
        if (this.disposed) return
        this.disposed = true
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
        this.connection?.close()
        this.connection = undefined
        const child = this.process
        this.process = undefined
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill()
        }
    }

    private requestPermission(
        params: acp.RequestPermissionRequest
    ): Promise<acp.RequestPermissionResponse> | acp.RequestPermissionResponse {
        if (this.driver.permissionPolicy === 'deny') {
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
        if (this.pending) {
            return { outcome: { outcome: 'cancelled' } }
        }
        const request: AgentdPendingRequest = {
            id: randomUUID(),
            kind: 'permission',
            prompt:
                params.toolCall.title ||
                `Permission requested for tool ${params.toolCall.toolCallId}`,
            options: params.options.map((option) => ({
                id: option.optionId,
                name: option.name,
                kind: option.kind
            }))
        }
        this.sink.setPending(request)
        return new Promise<acp.RequestPermissionResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending?.request.id !== request.id) return
                this.pending = undefined
                this.sink.clearPending()
                this.sink.setState('failed', 'ACP permission request timed out')
                resolve({ outcome: { outcome: 'cancelled' } })
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
            options: elicitationOptions(params)
        }
        this.sink.setPending(request)
        return new Promise<acp.CreateElicitationResponse>((resolve) => {
            const timer = setTimeout(() => {
                if (this.pendingInput?.request.id !== request.id) return
                this.pendingInput = undefined
                this.sink.clearPending()
                this.sink.setState('failed', 'ACP input request timed out')
                resolve({ action: 'cancel' })
            }, this.driver.permissionTimeoutMs)
            this.pendingInput = { request, params, resolve, timer }
        })
    }

    private finishInput(message: string) {
        const pending = this.pendingInput
        if (!pending) return
        const normalized = message.trim().toLowerCase()
        let response: acp.CreateElicitationResponse
        if (['cancel', '取消'].includes(normalized)) {
            response = { action: 'cancel' }
        } else if (['decline', '拒绝', '不同意'].includes(normalized)) {
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
        const update = params.update
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type === 'text') {
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

    private captureStderr(child: ChildProcessWithoutNullStreams) {
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
            drain(true)
        }
        child.stderr.on('data', (chunk) => {
            buffer += String(chunk)
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
