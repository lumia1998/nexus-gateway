import type { AgentdAgentView, AgentdApiKeyView, AgentdControlPlaneView, AgentdRunView } from '../../types.js'

export type Page = 'overview' | 'runs' | 'agents' | 'workspaces' | 'keys' | 'settings'
export type Resource = 'config' | 'apiKeys' | 'overview' | 'runs' | 'metrics'
export interface ResourceState { status: 'idle' | 'loading' | 'ready' | 'error'; lastSuccessAt: number }
export type ConfigState = Pick<AgentdControlPlaneView, 'workspaceRoots' | 'driverKinds' | 'agents'> & Partial<AgentdControlPlaneView>
export interface RunStats { active: number; completed: number; failed: number }
export interface RunListPayload { runs: AgentdRunView[]; total: number; stats: RunStats }
export interface OverviewPayload { agents: AgentdAgentView[]; sessions: number }
export interface MetricsPayload {
  runs?: RunStats & { total: number }
  recentRuns?: AgentdRunView[]
  rssBytes?: number
  sessions?: number
  activeSse?: number
  requests?: number
  failures?: number
  quotaRejections?: number
  storage?: Record<string, unknown>
  storageMetrics?: ReturnType<import('../../run-store.js').RunStore['metrics']>
}
export interface ResourcePayloads {
  config: ConfigState
  apiKeys: { apiKeys: AgentdApiKeyView[] }
  overview: OverviewPayload
  runs: RunListPayload
  metrics: MetricsPayload
}
export interface WebUiState {
  page: Page
  config: ConfigState
  readiness: AgentdAgentView[]
  apiKeys: AgentdApiKeyView[]
  runs: AgentdRunView[]
  runTotal: number
  runStats: RunStats
  sessions: number
  search: string
  protocol: string
  status: string
  runSearch: string
  runAgent: string
  runStatus: string
  runOffset: number
  runPageSize: number
  runHasNew: boolean
  selectedRunId?: string
  authEpoch: number
  authenticated: boolean
  resources: Record<Resource, ResourceState>
  metrics: MetricsPayload | null
}
export type ApiOptions = Omit<RequestInit, 'body'> & { body?: string | Record<string, unknown> }
