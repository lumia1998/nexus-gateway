import { state } from './state.js'
import { byId, escapeHtml } from './dom.js'
import { icons } from './icons.js'
import { localizeError } from './api.js'
import { withBusy } from './toast.js'

import { refreshReadiness, retryResource } from './data.js'
import { runStatusLabel } from './format.js'

import { setResults, setActions, announce, stat, emptyState } from './render-shared.js'
import { readinessRows, statusMarkup } from './render-agents.js'

export function overviewAgent(agent) {
  return '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(agent.name) + '</strong><small>' +
    escapeHtml(agent.protocol.toUpperCase() + (agent.driver ? ' · ' + agent.driver : '')) +
    (agent.error ? ' · ' + escapeHtml(localizeError(agent.error)) : '') + '</small></div><div class="row-actions">' +
    '<button class="button small" data-agent-edit="' + escapeHtml(agent.id) + '">编辑</button><button class="button small" data-agent-diagnostics="' + escapeHtml(agent.id) + '">连接诊断</button>' + statusMarkup(agent) + '</div></div>'
}

/** 紧凑指标单元：标签 + 值，不单独成卡。 */
function miniMetric(label, value) {
  return '<div class="run-detail-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(String(value)) + '</strong></div>'
}

const WAITING_STATES = new Set(['input_required', 'permission_required'])

function attentionRow(run) {
  const waiting = WAITING_STATES.has(run.state)
  const actions =
    (waiting ? '<button class="button small" data-run-quick-cancel="' + escapeHtml(run.id) + '">取消任务</button>' : '') +
    '<button class="button small" data-run-detail="' + escapeHtml(run.id) + '">查看详情</button>' +
    '<button class="button small danger" data-run-quick-delete="' + escapeHtml(run.id) + '">删除记录</button>'
  return '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(run.agentName) + '</strong><small>' +
    escapeHtml(runStatusLabel(run.state) + ' · ' + (run.taskPreview || '')) + '</small></div><div class="row-actions">' + actions + '</div></div>'
}

export function renderOverview() {
  const agents = readinessRows()
  const enabled = agents.filter((agent) => agent.enabled)
  const ready = enabled.filter((agent) => agent.ready).length
  const attention = agents.filter((agent) => agent.enabled && !agent.checking && (!agent.ready || agent.error))
  const configPending = ['idle', 'loading'].includes(state.resources.config.status)
  const metrics = state.metrics || {}
  const storage = metrics.storageMetrics
  const recent = (metrics.recentRuns || []).filter((run) => WAITING_STATES.has(run.state) || run.state === 'failed').slice(0, 5)
  setActions('<button id="refresh-overview" class="button">' + icons.refresh + '刷新</button>')
  const configBroken = !state.resources.config.lastSuccessAt
  const body = configPending && agents.length === 0
    ? '<p class="panel-note">正在加载网关配置…</p>'
    : configBroken
    ? '<p class="panel-note">配置读取失败，请使用上方重试入口恢复。</p>'
    : agents.length === 0
    ? emptyState(icons.robot, '尚未配置智能体', '', { action: 'add-agent', label: '添加智能体' })
    : '<div class="panel-body overview-list">' + attention.map(overviewAgent).join('') + '</div>'
  /* 没有异常、有配置、有智能体时整块隐藏：健康状态由顶部统计表达即可 */
  const agentPanel = (configPending && agents.length === 0) || configBroken || agents.length === 0 || attention.length
    ? '<div class="panel"><div class="panel-header"><h2>智能体状态</h2><span class="muted">' + (attention.length ? attention.length + ' 个需要注意' : ready + ' 个可用') + '</span></div>' +
      body +
    '</div>'
    : ''
  const sysMetrics =
    miniMetric('现有会话', metrics.sessions ?? (state.resources.overview.lastSuccessAt ? state.sessions : '—')) +
    miniMetric('SSE 连接', metrics.activeSse ?? '—') +
    miniMetric('内存 RSS', metrics.rssBytes === undefined ? '—' : Math.round(metrics.rssBytes / 1024 / 1024) + ' MiB') +
    miniMetric('配额拒绝', metrics.quotaRejections ?? '—') +
    (storage ? miniMetric('历史文件', (storage.historyBytes / 1024 / 1024).toFixed(1) + ' MiB') +
      miniMetric('保留记录', storage.retainedRuns) +
      miniMetric('待写入', storage.pendingWrites) +
      miniMetric('历史写入失败', storage.writeFailures) : '')
  setResults('<div class="stats">' +
      stat('智能体', agents.length, '#/agents') +
      stat('启用', enabled.length) +
      stat('异常', attention.length, attention.length ? '#/agents?status=failed' : undefined) +
      stat('活动任务', metrics.runs?.active ?? '—', '#/runs') +
    '</div>' +
    (agentPanel || '') +
    (sysMetrics ? '<div class="panel"><div class="panel-header"><h2>系统状态</h2></div>' +
      '<div class="run-detail-grid compact">' + sysMetrics + '</div></div>' : '') +
    '<div class="panel"><div class="panel-header"><h2>失败与等待处理</h2>' +
      (recent.length >= 5 ? '<a class="button small" href="#/runs?state=failed">查看全部</a>' : '<span class="muted">最近 5 条</span>') + '</div>' +
      (recent.length ? '<div class="panel-body">' + recent.map(attentionRow).join('') + '</div>' : '<p class="panel-note">' + (state.resources.metrics.lastSuccessAt ? '没有最近失败或等待处理的任务。' : '正在读取任务统计…') + '</p>') + '</div>')
  byId('refresh-overview').onclick = (event) => withBusy(event.currentTarget, async () => {
    await Promise.allSettled([refreshReadiness(true), retryResource('metrics')])
  })
  announce(agents.length + ' 个智能体，' + enabled.length + ' 个启用，' + attention.length + ' 个需要注意')
}
