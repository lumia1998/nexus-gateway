import { randomUUID } from 'node:crypto'
import {
    Role,
    TaskState,
    type AgentCard,
    type Artifact,
    type Message,
    type Part,
    type SendMessageRequest,
    type StreamResponse,
    type Task,
    type TaskStatus
} from '@a2a-js/sdk'
import {
    ClientFactory,
    DefaultAgentCardResolver,
    JsonRpcTransportFactory,
    RestTransportFactory
} from '@a2a-js/sdk/client'
import type { AgentSessionRuntime, AgentSessionSink } from '../session-contract.js'
import type {
    AgentdA2AConfig,
    AgentdAgentView,
    AgentdArtifact,
    AgentdInputAttachment,
    AgentdPendingResponse
} from '../types.js'

export async function probeA2AAgent(
    id: string,
    config: AgentdA2AConfig
): Promise<AgentdAgentView> {
    const startedAt = Date.now()
    if (config.enabled === false) return disabledView(id, config)
    try {
        const resolver = createResolver(config)
        const card = await resolveAgentCard(resolver, config)
        return {
            id,
            name: config.name || card.name || id,
            description: config.description || card.description || undefined,
            protocol: 'a2a',
            ready: true,
            enabled: true,
            version: card.version || undefined,
            checkedAt: Date.now(),
            responseMs: Date.now() - startedAt
        }
    } catch (error) {
        return {
            id,
            name: config.name || id,
            description: config.description,
            protocol: 'a2a',
            ready: false,
            enabled: true,
            error: errorMessage(error),
            checkedAt: Date.now(),
            responseMs: Date.now() - startedAt
        }
    }
}

export class A2AClientRuntime implements AgentSessionRuntime {
    private client?: Awaited<ReturnType<ClientFactory['createFromAgentCard']>>
    private card?: AgentCard
    private taskId = ''
    private contextId = ''
    private prompting = false
    private disposed = false
    private activeController?: AbortController
    private readonly artifactCache = new Map<string, AgentdArtifact>()
    private readonly emittedMessages = new Set<string>()

    constructor(
        private readonly config: AgentdA2AConfig,
        private readonly sink: AgentSessionSink,
        private readonly promptTimeoutMs: number
    ) {}

    async start() {
        const resolver = createResolver(this.config)
        this.card = await resolveAgentCard(resolver, this.config)
        const fetchImpl = authenticatedFetch(this.config)
        const legacyCompat = { enabled: true }
        const factory = new ClientFactory({
            cardResolver: resolver,
            preferredTransports: preferredTransports(this.config),
            transports: [
                new JsonRpcTransportFactory({ fetchImpl, legacyCompat }),
                new RestTransportFactory({ fetchImpl, legacyCompat })
            ]
        })
        this.client = await factory.createFromAgentCard(this.card)
        this.sink.setState('created')
    }

    async prompt(message: string, attachments: AgentdInputAttachment[] = []) {
        if (!this.client || !this.card) throw new Error('A2A runtime is not connected')
        if (this.prompting) throw new Error('A2A session is already processing a message')
        if (this.disposed) throw new Error('A2A runtime is disposed')
        this.prompting = true
        this.sink.clearPending()
        this.sink.setState('running')
        const controller = new AbortController()
        this.activeController = controller
        const timer = setTimeout(
            () => controller.abort(new Error('A2A message timed out')),
            Math.min(this.promptTimeoutMs, this.config.timeoutMs || this.promptTimeoutMs)
        )
        timer.unref?.()
        try {
            const request = this.messageRequest(message, attachments)
            for await (const response of this.client.sendMessageStream(request, {
                signal: controller.signal
            })) {
                this.processResponse(response)
            }
            if (this.sink.state === 'running') this.sink.setState('completed')
        } catch (error) {
            if (this.sink.state !== 'canceled') {
                this.sink.setState('failed', abortMessage(error, controller.signal))
            }
        } finally {
            clearTimeout(timer)
            if (this.activeController === controller) this.activeController = undefined
            this.prompting = false
        }
    }

    async respondPending(
        response: AgentdPendingResponse | string,
        attachments: AgentdInputAttachment[] = []
    ) {
        if (this.sink.state !== 'input_required') {
            throw new Error('A2A session is not waiting for input')
        }
        const message =
            typeof response === 'string'
                ? response
                : response.action === 'cancel'
                  ? 'cancel'
                  : response.action === 'decline'
                    ? 'decline'
                    : response.message ?? response.optionId ?? ''
        if (!message.trim()) throw new Error('A2A pending response is empty')
        this.sink.clearPending()
        await this.prompt(message, attachments)
    }

    async cancel() {
        this.activeController?.abort(new Error('A2A session canceled'))
        if (this.client && this.taskId) {
            try {
                await this.client.cancelTask(
                    { tenant: '', id: this.taskId, metadata: undefined },
                    { signal: AbortSignal.timeout(this.config.timeoutMs || 60_000) }
                )
            } catch (error) {
                this.sink.emit('terminal_output', {
                    stream: 'system',
                    text: `A2A cancellation request failed: ${errorMessage(error)}`
                })
            }
        }
        this.sink.clearPending()
        this.sink.setState('canceled')
    }

    async dispose() {
        this.disposed = true
        this.activeController?.abort(new Error('A2A runtime disposed'))
        this.activeController = undefined
    }

    private messageRequest(
        text: string,
        attachments: AgentdInputAttachment[]
    ): SendMessageRequest {
        return {
            tenant: '',
            message: {
                messageId: randomUUID(),
                contextId: this.contextId,
                taskId: this.taskId,
                role: Role.ROLE_USER,
                parts: [
                    {
                        content: { $case: 'text', value: text },
                        metadata: undefined,
                        filename: '',
                        mediaType: 'text/plain'
                    },
                    ...attachments.map((attachment): Part => ({
                        content: {
                            $case: 'raw',
                            value: Buffer.from(attachment.bytes)
                        },
                        metadata: undefined,
                        filename: attachment.name,
                        mediaType: attachment.mediaType || 'application/octet-stream'
                    }))
                ],
                metadata: undefined,
                extensions: [],
                referenceTaskIds: []
            },
            configuration: {
                acceptedOutputModes: this.card?.defaultOutputModes?.length
                    ? [...this.card.defaultOutputModes]
                    : ['text/plain', 'application/octet-stream'],
                taskPushNotificationConfig: undefined,
                returnImmediately: false
            },
            metadata: undefined
        }
    }

    private processResponse(response: StreamResponse) {
        const payload = response.payload
        if (!payload) return
        switch (payload.$case) {
            case 'message':
                this.processMessage(payload.value)
                break
            case 'task':
                this.processTask(payload.value)
                break
            case 'statusUpdate':
                this.captureIds(payload.value.taskId, payload.value.contextId)
                this.processStatus(payload.value.status)
                break
            case 'artifactUpdate':
                this.captureIds(payload.value.taskId, payload.value.contextId)
                this.processArtifact(
                    payload.value.artifact,
                    payload.value.append,
                    payload.value.lastChunk
                )
                break
        }
    }

    private processTask(task: Task) {
        this.captureIds(task.id, task.contextId)
        for (const artifact of task.artifacts) this.processArtifact(artifact, false, true)
        this.processStatus(task.status)
    }

    private processMessage(message: Message | undefined) {
        if (!message || message.role !== Role.ROLE_AGENT) return
        this.captureIds(message.taskId, message.contextId)
        if (message.messageId && this.emittedMessages.has(message.messageId)) return
        if (message.messageId) this.emittedMessages.add(message.messageId)
        for (const text of textParts(message.parts)) {
            this.sink.appendOutput(text)
            this.sink.emit('assistant_chunk', {
                messageId: message.messageId || undefined,
                content: { type: 'text', text }
            })
        }
    }

    private processStatus(status: TaskStatus | undefined) {
        if (!status) return
        this.processMessage(status.message)
        const statusText = textParts(status.message?.parts || []).join('\n').trim()
        switch (status.state) {
            case TaskState.TASK_STATE_SUBMITTED:
            case TaskState.TASK_STATE_WORKING:
                this.sink.setState('running')
                break
            case TaskState.TASK_STATE_COMPLETED:
                this.sink.clearPending()
                this.sink.setState('completed')
                break
            case TaskState.TASK_STATE_CANCELED:
                this.sink.clearPending()
                this.sink.setState('canceled')
                break
            case TaskState.TASK_STATE_INPUT_REQUIRED:
                this.sink.setPending({
                    id: this.taskId || randomUUID(),
                    kind: 'input',
                    prompt: statusText || 'The A2A agent requires additional input.'
                })
                break
            case TaskState.TASK_STATE_FAILED:
            case TaskState.TASK_STATE_REJECTED:
            case TaskState.TASK_STATE_AUTH_REQUIRED:
                this.sink.clearPending()
                this.sink.setState(
                    'failed',
                    statusText || taskStateError(status.state)
                )
                break
        }
    }

    private processArtifact(artifact: Artifact | undefined, append: boolean, complete: boolean) {
        if (!artifact) return
        const mapped = artifactFromA2A(artifact)
        const previous = this.artifactCache.get(mapped.id || '')
        const next =
            append && previous
                ? {
                      ...previous,
                      ...mapped,
                      text: `${previous.text || ''}${mapped.text || ''}` || undefined,
                      metadata: {
                          ...previous.metadata,
                          ...mapped.metadata,
                          complete
                      }
                  }
                : {
                      ...mapped,
                      metadata: { ...mapped.metadata, complete }
                  }
        if (next.id) this.artifactCache.set(next.id, next)
        this.sink.addArtifact(next)
        this.sink.emit('artifact', next)
    }

    private captureIds(taskId?: string, contextId?: string) {
        if (taskId) {
            this.taskId = taskId
            this.sink.setProtocolSessionId(taskId)
        }
        if (contextId) this.contextId = contextId
    }
}

function createResolver(config: AgentdA2AConfig) {
    return new DefaultAgentCardResolver({
        fetchImpl: authenticatedFetch(config),
        legacyCompat: { enabled: true }
    })
}

function resolveAgentCard(
    resolver: DefaultAgentCardResolver,
    config: AgentdA2AConfig
) {
    if (config.agentCardUrl) return resolver.resolve(config.agentCardUrl, '')
    if (config.agentUrl) return resolver.resolve(config.agentUrl)
    throw new Error('A2A Agent Card URL is required')
}

function preferredTransports(
    config: AgentdA2AConfig
): Array<'JSONRPC' | 'HTTP+JSON'> | undefined {
    if (config.preferredTransport === 'jsonrpc') return ['JSONRPC']
    if (config.preferredTransport === 'http-json') return ['HTTP+JSON']
    return undefined
}

function authenticatedFetch(config: AgentdA2AConfig): typeof fetch {
    return async (input, init = {}) => {
        const headers = new Headers(init.headers)
        if (config.auth?.type === 'bearer' && config.auth.value) {
            headers.set('Authorization', `Bearer ${config.auth.value}`)
        } else if (
            config.auth?.type === 'header' &&
            config.auth.headerName &&
            config.auth.value
        ) {
            headers.set(config.auth.headerName, config.auth.value)
        }
        return fetch(input, {
            ...init,
            headers,
            signal: init.signal || AbortSignal.timeout(config.timeoutMs || 60_000)
        })
    }
}

function artifactFromA2A(artifact: Artifact): AgentdArtifact {
    const text = textParts(artifact.parts).join('') || undefined
    const urlPart = artifact.parts.find((part) => part.content?.$case === 'url')
    const rawPart = artifact.parts.find((part) => part.content?.$case === 'raw')
    const dataParts = artifact.parts
        .filter((part) => part.content?.$case === 'data')
        .map((part) => part.content?.$case === 'data' ? part.content.value : undefined)
    return {
        id: artifact.artifactId,
        name: artifact.name || artifact.artifactId,
        description: artifact.description || undefined,
        text,
        url: urlPart?.content?.$case === 'url' ? urlPart.content.value : undefined,
        bytesBase64:
            rawPart?.content?.$case === 'raw'
                ? Buffer.from(rawPart.content.value).toString('base64')
                : undefined,
        mediaType: artifact.parts.find((part) => part.mediaType)?.mediaType || undefined,
        data: dataParts.length ? dataParts : undefined,
        metadata: artifact.metadata || undefined
    }
}

function textParts(parts: Part[]) {
    return parts.flatMap((part) =>
        part.content?.$case === 'text' && part.content.value ? [part.content.value] : []
    )
}

function taskStateError(state: TaskState) {
    if (state === TaskState.TASK_STATE_AUTH_REQUIRED) {
        return 'A2A agent requires authentication'
    }
    if (state === TaskState.TASK_STATE_REJECTED) return 'A2A agent rejected the task'
    return 'A2A task failed'
}

function abortMessage(error: unknown, signal: AbortSignal) {
    if (signal.aborted) {
        return signal.reason instanceof Error ? signal.reason.message : 'A2A request aborted'
    }
    return errorMessage(error)
}

function disabledView(id: string, config: AgentdA2AConfig): AgentdAgentView {
    return {
        id,
        name: config.name || id,
        description: config.description,
        protocol: 'a2a',
        ready: false,
        enabled: false,
        error: 'Agent is disabled',
        checkedAt: Date.now()
    }
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
