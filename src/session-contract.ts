import type {
    AgentdArtifact,
    AgentdEventType,
    AgentdInputAttachment,
    AgentdPendingRequest,
    AgentdPendingResponse,
    AgentdSessionState,
    AgentdTurnCompletionProof
} from './types.js'

export interface AgentSessionSink {
    readonly id: string
    readonly state: AgentdSessionState
    readonly protocolSessionId?: string
    setProtocolSessionId(id: string): void
    setState(state: AgentdSessionState, error?: string): void
    completeTurn(proof: AgentdTurnCompletionProof): boolean
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
    respondPending(
        response: AgentdPendingResponse | string,
        attachments?: AgentdInputAttachment[]
    ): Promise<void>
    cancel(): Promise<void>
    dispose(): Promise<void>
}
