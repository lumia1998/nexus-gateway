export const state = {
  page: 'overview',
  config: { workspaceRoots: [], driverKinds: [], agents: [] },
  readiness: [],
  apiKeys: [],
  runs: [],
  runTotal: 0,
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
  overview: ['总览', '查看已配置智能体运行时的实时状态。'],
  runs: ['运行记录', '追踪当前任务进度，并查看已完成或失败的历史任务。'],
  agents: ['智能体', '配置本地 ACP 进程和远程 A2A 智能体。'],
  workspaces: ['工作区', '管理 ACP 智能体允许访问的路径。'],
  keys: ['API 密钥', '管理 Agent Nexus 数据接口的客户端凭据。'],
  settings: ['运行设置', '调整会话生命周期、任务超时和后台清理周期。']
}

