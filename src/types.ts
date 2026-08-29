export type AgentdSessionState =
    | 'created'
    | 'running'
    | 'input_required'
    | 'permission_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export type AgentdProtocol = 'acp' | 'a2a'
export type PermissionPolicy = 'ask' | 'deny'

export const agentdDriverKinds = [
    'opencode',
    'claude',
    'codex',
    'pi',
    'openclaw',
    'hermes'
] as const

export type AgentdDriverKind = (typeof agentdDriverKinds)[number]

export interface AgentdDriverConfig {
    protocol?: 'acp'
    driver: AgentdDriverKind
    name?: string
    description?: string
    enabled?: boolean
    workspace?: string
    command?: string
    args?: string[]
    inheritEnv?: string[]
    env?: Record<string, string>
    permissionPolicy?: PermissionPolicy
    permissionTimeoutMs?: number
}

export type A2AAuthType = 'none' | 'bearer' | 'header'
export type A2ATransportPreference = 'auto' | 'jsonrpc' | 'http-json'

export interface AgentdA2AConfig {
    protocol: 'a2a'
    name?: string
    description?: string
    enabled?: boolean
    /** Full Agent Card JSON URL. Preferred for new configurations. */
    agentCardUrl?: string
    /** @deprecated Legacy service root used for well-known Agent Card discovery. */
    agentUrl?: string
    preferredTransport?: A2ATransportPreference
    auth?: {
        type: A2AAuthType
        value?: string
        headerName?: string
    }
    timeoutMs?: number
}

export type AgentdAgentConfig = AgentdDriverConfig | AgentdA2AConfig

export interface AgentdApiKeyScope {
    allAgents: boolean
    agentIds: string[]
}

export interface AgentdApiKeyConfig {
    id: string
    name: string
    secret: string
    enabled: boolean
    scope: AgentdApiKeyScope
    createdAt: number
    lastUsedAt?: number
}

export interface AgentdConfig {
    listen: {
        host: string
        port: number
    }
    initialized: boolean
    /** Legacy data-plane credential. Loaded as an all-agents API key. */
    authToken?: string
    adminPasswordHash?: string
    apiKeys?: AgentdApiKeyConfig[]
    workspaceRoots: string[]
    maxRequestBytes: number
    maxAttachmentBytes?: number
    maxEventsPerSession: number
    maxOutputChars: number
    sessionTtlMs: number
    cleanupIntervalMs?: number
    requestTimeoutMs?: number
    promptTimeoutMs?: number
    maxSessions?: number
    maxSseConnections?: number
    maxConnections?: number
    adminSessionTtlMs?: number
    secureAdminCookies?: boolean
    agents: Record<string, AgentdAgentConfig>
}

export interface AgentdAgentView {
    id: string
    name: string
    description?: string
    protocol: AgentdProtocol
    driver?: AgentdDriverKind
    ready: boolean
    enabled?: boolean
    workspace?: string
    version?: string
    error?: string
    checkedAt?: number
    responseMs?: number
}

export interface AgentdAgentConfigView {
    id: string
    protocol: AgentdProtocol
    name: string
    description?: string
    enabled: boolean
    driver?: AgentdDriverKind
    workspace?: string
    permissionPolicy?: PermissionPolicy
    permissionTimeoutMs?: number
    agentCardUrl?: string
    agentUrl?: string
    preferredTransport?: A2ATransportPreference
    auth?: {
        type: A2AAuthType
        headerName?: string
        configured: boolean
    }
    timeoutMs?: number
}

export interface AgentdControlPlaneView {
    workspaceRoots: string[]
    driverKinds: AgentdDriverKind[]
    sessionTtlMs: number
    promptTimeoutMs: number
    cleanupIntervalMs: number
    agents: AgentdAgentConfigView[]
}

export interface AgentdInputAttachmentView {
    id: string
    name: string
    mediaType?: string
    size: number
}

export interface AgentdInputAttachment {
    id: string
    name: string
    mediaType?: string
    bytes: Buffer
}

export interface AgentdApiKeyView {
    id: string
    name: string
    enabled: boolean
    scope: AgentdApiKeyScope
    suffix: string
    createdAt: number
    lastUsedAt?: number
    legacy: boolean
}

export interface AgentdApiKeyPrincipal {
    id: string
    scope: AgentdApiKeyScope
}

export interface AgentdPendingRequest {
    id: string
    kind: 'permission' | 'input'
    prompt: string
    options?: Array<{
        id: string
        name: string
        kind?: string
    }>
}

export interface AgentdPendingResponse {
    requestId: string
    message?: string
    optionId?: string
    action?: 'accept' | 'decline' | 'cancel'
}

export interface AgentdArtifact {
    id?: string
    name?: string
    description?: string
    text?: string
    url?: string
    filename?: string
    mediaType?: string
    data?: unknown
    bytesBase64?: string
    metadata?: Record<string, unknown>
}

export interface AgentdSessionView {
    id: string
    /** Identifies the Gateway process that owns this in-memory session. */
    instanceId?: string
    runId?: string
    protocol: AgentdProtocol
    protocolSessionId?: string
    /** Backward-compatible alias for ACP clients. */
    acpSessionId?: string
    agentId: string
    workspace?: string
    state: AgentdSessionState
    output?: string
    error?: string
    artifacts: AgentdArtifact[]
    inputAttachments?: AgentdInputAttachmentView[]
    pendingRequest?: AgentdPendingRequest
    lastEventId?: string
    createdAt: number
    updatedAt: number
}

export interface AgentdRunProgress {
    phase: string
    message?: string
    percent?: number
}

export interface AgentdRunArtifactView {
    id?: string
    name?: string
    description?: string
    url?: string
    filename?: string
    mediaType?: string
    metadata?: Record<string, unknown>
}

export interface AgentdRunView {
    id: string
    sessionId: string
    agentId: string
    agentName: string
    protocol: AgentdProtocol
    workspace?: string
    protocolSessionId?: string
    task: string
    taskTruncated?: boolean
    state: AgentdSessionState
    progress: AgentdRunProgress
    resultSummary?: string
    error?: string
    artifactCount: number
    inputAttachmentCount?: number
    startedAt: number
    updatedAt: number
    endedAt?: number
    durationMs?: number
}

export interface AgentdRunDetail extends AgentdRunView {
    output?: string
    artifacts: AgentdRunArtifactView[]
}

export type AgentdEventType =
    | 'session_state'
    | 'assistant_chunk'
    | 'thought_chunk'
    | 'plan'
    | 'tool_call'
    | 'tool_update'
    | 'terminal_output'
    | 'file_activity'
    | 'artifact'
    | 'permission_required'
    | 'input_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export interface AgentdEvent {
    id: string
    sessionId: string
    type: AgentdEventType
    timestamp: number
    data?: unknown
}
