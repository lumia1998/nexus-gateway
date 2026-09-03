export const state = {
  page: 'overview',
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
  runAgent: 'all',
  runStatus: 'all',
  authenticated: false
}

export const pageMeta = {
  overview: '总览',
  runs: '运行记录',
  agents: '智能体',
  workspaces: '工作区',
  keys: 'API 密钥',
  settings: '设置'
}
