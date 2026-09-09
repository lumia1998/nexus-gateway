import { state } from './state.js'
import { byId, escapeHtml } from './dom.js'
import { icons } from './icons.js'
import { localizeError } from './api.js'
import { withBusy } from './toast.js'

import { refreshReadiness, retryResource } from './data.js'
import { formatDate, runStatusLabel } from './format.js'

import { setResults, setActions, announce, stat, emptyState } from './render-shared.js'
import { readinessRows, statusMarkup } from './render-agents.js'

export function overviewAgent(agent) {
  return '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(agent.name) + '</strong><small>' +
    escapeHtml(agent.protocol.toUpperCase() + (agent.driver ? ' · ' + agent.driver : '')) +
    (agent.error ? ' · ' + escapeHtml(localizeError(agent.error)) : '') + '</small></div><div class="row-actions">' +
    '<button class="button small" data-agent-edit="' + escapeHtml(agent.id) + '">编辑</button><button class="button small" data-agent-diagnostics="' + escapeHtml(agent.id) + '">连接诊断</button>' + statusMarkup(agent) + '</div></div>'
}

export function renderOverview() {
  const agents = readinessRows()
  const enabled = agents.filter((agent) => agent.enabled)
  const ready = enabled.filter((agent) => agent.ready).length
  const checking = agents.filter((agent) => agent.enabled && agent.checking).length
  const attention = agents.filter((agent) => agent.enabled && !agent.checking && (!agent.ready || agent.error))
  const overviewFailed = state.resources.overview.status === 'error'
  const configPending = ['idle', 'loading'].includes(state.resources.config.status)
  const metrics = state.metrics || {}
  const storage = metrics.storageMetrics
  const recent = (metrics.recentRuns || []).filter((run) => ['failed', 'input_required', 'permission_required'].includes(run.state)).slice(0, 5)
  setActions('<button id="refresh-overview" class="button">' + icons.refresh + '刷新</button>')
  const body = configPending && agents.length === 0
    ? '<p class="panel-note">正在加载网关配置…</p>'
    : !state.resources.config.lastSuccessAt
    ? '<p class="panel-note">配置读取失败，请使用上方重试入口恢复。</p>'
    : agents.length === 0
    ? emptyState(icons.robot, '尚未配置智能体', '', { action: 'add-agent', label: '添加智能体' })
    : attention.length
      ? '<div class="panel-body overview-list">' + attention.map(overviewAgent).join('') + '</div>'
      : '<p class="panel-note">' + (overviewFailed ? '探测刷新失败，以下状态可能已过期。' : checking ? '正在检查 ' + checking + ' 个智能体。' : enabled.length === 0 ? '全部智能体已停用，未执行探测。' : '全部启用的智能体均可用。') + '</p>'
  setResults('<div class="stats">' +
      stat('智能体', agents.length) +
      stat('启用', enabled.length) +
      stat('异常', attention.length) +
      stat('活动任务', metrics.runs?.active ?? '—') +
    '</div>' +
    '<div class="panel"><div class="panel-header"><h2>智能体状态</h2><span class="muted">' + (attention.length ? attention.length + ' 个需要注意' : ready + ' 个可用') + '</span></div>' +
      body +
    '</div><div class="stats overview-metrics">' +
      stat('现有会话', metrics.sessions ?? (state.resources.overview.lastSuccessAt ? state.sessions : '—')) +
      stat('SSE 连接', metrics.activeSse ?? '—') +
      stat('内存 RSS', metrics.rssBytes === undefined ? '—' : Math.round(metrics.rssBytes / 1024 / 1024) + ' MiB') +
      stat('配额拒绝', metrics.quotaRejections ?? '—') +
    '</div>' + (storage ? '<div class="stats overview-storage">' +
      stat('历史文件', (storage.historyBytes / 1024 / 1024).toFixed(1) + ' MiB') +
      stat('保留记录', storage.retainedRuns) +
      stat('待写入', storage.pendingWrites) +
      stat('历史写入失败', storage.writeFailures) + '</div>' : '') +
    '<div class="panel"><div class="panel-header"><h2>失败与等待处理</h2><span class="muted">' + escapeHtml(state.resources.metrics.lastSuccessAt ? formatDate(state.resources.metrics.lastSuccessAt) : '统计尚未读取') + '</span></div>' +
      (recent.length ? '<div class="panel-body">' + recent.map((run) => '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(run.agentName) + '</strong><small>' + escapeHtml(runStatusLabel(run.state) + ' · ' + (run.taskPreview || '')) + '</small></div><button class="button small" data-run-detail="' + escapeHtml(run.id) + '">查看详情</button></div>').join('') + '</div>' : '<p class="panel-note">' + (state.resources.metrics.lastSuccessAt ? '没有最近失败或等待处理的任务。' : '正在读取任务统计…') + '</p>') + '</div>')
  byId('refresh-overview').onclick = (event) => withBusy(event.currentTarget, async () => {
    await Promise.allSettled([refreshReadiness(true), retryResource('metrics')])
  })
  announce(agents.length + ' 个智能体，' + enabled.length + ' 个启用，' + attention.length + ' 个需要注意')
}
