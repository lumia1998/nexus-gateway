export type AgentdSessionState =
    | 'created'
    | 'running'
    | 'input_required'
    | 'permission_required'
    | 'completed'
    | 'failed'
    | 'canceled'

export type AgentdProtocol = 'acp' | 'a2a'
export type PermissionPolicy = 'ask' | 'allow' | 'deny'

export type AgentdTurnCompletionSource =
    | 'acp_prompt_response'
    | 'a2a_task_status'
    | 'a2a_message_stream'

export interface AgentdTurnCompletionProof {
    source: AgentdTurnCompletionSource
    stopReason: string
}

export interface AgentdTurnCompletion extends AgentdTurnCompletionProof {
    runId?: string
    protocol: AgentdProtocol
    verified: true
    outputPresent: boolean
    artifactCount: number
    completedAt: number
}

export const agentdDriverKinds = [
    'stdio',
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
    /** Arguments used by a command availability probe. */
    probeArgs?: string[]
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
    /** Maximum time allowed for one logical A2A task. Inherits global promptTimeoutMs when omitted. */
    taskTimeoutMs?: number
    /** Maximum time between bytes/events while reading an A2A stream. Inherits timeoutMs when omitted. */
    streamIdleTimeoutMs?: number
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
    /** Exact browser origins for named LAN hosts or TLS reverse proxies. */
    publicOrigins?: string[]
    /** Per-client budgets; changes require a restart. */
    quotas?: {
        maxSessionsPerKey: number
        maxRunningRunsPerKey: number
        maxSsePerKey: number
        maxUploadBytesPerKey: number
    }
    /** Persisted task metadata and output retention; active runs are protected. */
    history?: { maxRuns: number; retentionDays: number; maxBytes: number }
    /** Persisted artifact payload retention and queue limits. */
    artifacts?: { retentionDays: number; maxBytes: number; maxArtifactBytes: number; maxQueuedBytes: number }
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
    taskTimeoutMs?: number
    streamIdleTimeoutMs?: number
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

export type AgentdPendingInputType =
    | 'text'
    | 'choice'
    | 'confirmation'
    | 'payment'
    | 'unknown'

export interface AgentdPendingRequest {
    id: string
    kind: 'permission' | 'input'
    prompt: string
    /** Short, machine-readable step id derived from the elicitation source. */
    step?: string
    /**
     * Semantic classification of the pending prompt. Clients may specialise
     * their UX for `payment`, `confirmation`, `choice`, etc.
     */
    inputType?: AgentdPendingInputType
    options?: Array<{
        id: string
        name: string
        kind?: string
    }>
    /**
     * Extra fields extracted from the underlying elicitation (e.g. paymentUrl,
     * confirmation flags, or ACP form defaults). Kept as a plain record so we
     * do not couple the wire type to specific business schemas.
     */
    metadata?: Record<string, unknown>
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
    /** Structural proof that the current protocol turn reached a valid terminal boundary. */
    completion?: AgentdTurnCompletion
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
    size?: number
    downloadable?: boolean
    storageStatus?: 'pending' | 'available' | 'metadata_only' | 'expired' | 'evicted' | 'failed'
}

export interface AgentdRunView {
    id: string
    sessionId: string
    retryOfRunId?: string
    agentId: string
    agentName: string
    protocol: AgentdProtocol
    workspace?: string
    protocolSessionId?: string
    taskPreview: string
    taskTruncated?: boolean
    state: AgentdSessionState
    progress: AgentdRunProgress
    resultSummary?: string
    error?: string
    artifactCount: number
    inputAttachmentCount?: number
    completion?: AgentdTurnCompletion
    startedAt: number
    updatedAt: number
    endedAt?: number
    durationMs?: number
}

export interface AgentdRunDetail extends AgentdRunView {
    task: string
    output?: string
    artifacts: AgentdRunArtifactView[]
    controls?: AgentdRunControls
}

export interface AgentdRunControls {
    canCancel: boolean
    canRetry: boolean
    pendingRequest?: AgentdPendingRequest
    unavailableReason?: string
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
