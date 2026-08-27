import type {
    AgentdArtifact,
    AgentdEventType,
    AgentdInputAttachment,
    AgentdPendingRequest,
    AgentdSessionState
} from './types.js'

export interface AgentSessionSink {
    readonly id: string
    readonly state: AgentdSessionState
    readonly protocolSessionId?: string
    setProtocolSessionId(id: string): void
    setState(state: AgentdSessionState, error?: string): void
    appendOutput(text: string): void
    addArtifact(artifact: AgentdArtifact): void
    setPending(request: AgentdPendingRequest): void
    clearPending(): void
    emit(type: AgentdEventType, data?: unknown): void
}

export interface AcpSessionSink extends AgentSessionSink {
    readonly acpSessionId?: string
    setAcpSessionId(id: string): void
}

export interface AgentSessionRuntime {
    start(workspace?: string): Promise<void>
    prompt(message: string, attachments?: AgentdInputAttachment[]): Promise<void>
    respondPending(message: string, attachments?: AgentdInputAttachment[]): Promise<void>
    cancel(): Promise<void>
    dispose(): Promise<void>
}
