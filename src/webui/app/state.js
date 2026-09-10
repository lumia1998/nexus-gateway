// @ts-check
import { readLocationState } from './location-state.js'
const initialLocation = /** @type {Pick<import('./contracts.js').WebUiState, 'page'|'runAgent'|'runStatus'|'runPageSize'|'runOffset'|'selectedRunId'>} */ (readLocationState())
/** @type {import('./contracts.js').WebUiState} */
export const state = {
  config: { workspaceRoots: [], driverKinds: [], agents: [] },
  readiness: [],
  apiKeys: [],
  runs: [],
  runTotal: 0,
  runStats: { active: 0, completed: 0, failed: 0 },
  sessions: 0,
  search: '',
  protocol: 'all',
  status: 'all',
  runSearch: '',
  runHasNew: false,
  artifacts: [],
  artifactTotal: 0,
  artifactAgent: 'all',
  artifactKind: 'all',
  artifactOffset: 0,
  authEpoch: 0,
  authenticated: false,
  metrics: null,
  resources: {
    config: { status: 'idle', lastSuccessAt: 0 },
    apiKeys: { status: 'idle', lastSuccessAt: 0 },
    overview: { status: 'idle', lastSuccessAt: 0 },
    runs: { status: 'idle', lastSuccessAt: 0 },
    metrics: { status: 'idle', lastSuccessAt: 0 }
  },
  ...initialLocation
}

export const pageMeta = {
  overview: '总览',
  runs: '运行记录',
  artifacts: '产物',
  agents: '智能体',
  workspaces: '工作区',
  keys: 'API 密钥',
  settings: '设置'
}
