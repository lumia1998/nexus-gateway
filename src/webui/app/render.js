import { state, pageMeta } from './state.js'
import { byId, pageStats, pageToolbar, pageResults, pageStatus, actions, keyActionMenu, drawerForm, escapeHtml, selected, checked } from './dom.js'
import { icons } from './icons.js'
import { api, localizeError } from './api.js'
import { toast, runAction, withBusy } from './toast.js'
import { openDrawer, closeDrawer, getDrawerVersion } from './drawer.js'
import { showLogin } from './screens.js'
import { applyTheme } from './theme.js'
import { loadAll, refreshRuns, refreshReadiness } from './data.js'
import { shortId, formatDate, formatDuration, runStatusLabel, permissionLabel } from './format.js'

let actionsPage = null
let toolbarSignature = null
let resultsHtml = null

function setResults(html) {
  if (resultsHtml === html) return
  resultsHtml = html
  const focused = pageResults.contains(document.activeElement) ? document.activeElement : null
  pageResults.innerHTML = html
  if (focused) {
    const data = Object.entries(focused.dataset)
    const replacement = Array.from(pageResults.querySelectorAll('button, input, select')).find((element) =>
      focused.id ? focused.id === element.id : data.length && data.every(([key, value]) => element.dataset[key] === value))
    ;(replacement || document.querySelector('.nav-item.active'))?.focus({ preventScroll: true })
  }
}

function setActions(html) {
  if (actionsPage === state.page) return
  actionsPage = state.page
  actions.innerHTML = html
}

function setToolbar(signature, html = '') {
  if (toolbarSignature === signature) return
  toolbarSignature = signature
  pageToolbar.innerHTML = html
}

function announce(message) {
  const summary = pageMeta[state.page] + '：' + message
  if (pageStatus.textContent !== summary) pageStatus.textContent = summary
}

export function render() {
  byId('page-title').textContent = pageMeta[state.page]
  byId('page-content').closest('.main')?.classList.toggle('settings-page', state.page === 'settings')
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === state.page)
    if (item.dataset.page === state.page) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
  if (state.page !== 'runs') pageStats.innerHTML = ''
  if (state.page !== 'runs' && state.page !== 'agents') setToolbar('')
  if (state.page === 'overview') renderOverview()
  if (state.page === 'runs') renderRuns()
  if (state.page === 'agents') renderAgents()
  if (state.page === 'workspaces') renderWorkspaces()
  if (state.page === 'keys') renderApiKeys()
  if (state.page === 'settings') renderSettings()
}

/* ── Overview ─────────────────────────────────────────────────────── */

function stat(label, value) {
  return '<div class="stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
}

function statusMarkup(agent) {
  if (!agent.enabled) return '<span class="status">已禁用</span>'
  if (agent.checking) return '<span class="status checking">检查中</span>'
  return agent.ready ? '<span class="status ready">就绪</span>' : '<span class="status failed">不可用</span>'
}

function readinessById() {
  return new Map(state.readiness.map((agent) => [agent.id, agent]))
}

/* 就绪结果里没有的 Agent 视为「尚未探测」，不能当成不可用 */
function agentReadiness(agent, lookup) {
  return lookup.get(agent.id) || {
    id: agent.id,
    name: agent.name,
    protocol: agent.protocol,
    driver: agent.driver,
    enabled: agent.enabled,
    ready: false,
    checking: true
  }
}

export function readinessRows() {
  const lookup = readinessById()
  return state.config.agents.map((agent) => agentReadiness(agent, lookup))
}

function overviewAgent(agent) {
  return '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(agent.name) + '</strong><small>' +
    escapeHtml(agent.protocol.toUpperCase() + (agent.driver ? ' · ' + agent.driver : '')) +
    (agent.error ? ' · ' + escapeHtml(localizeError(agent.error)) : '') + '</small></div>' + statusMarkup(agent) + '</div>'
}

function renderOverview() {
  const agents = readinessRows()
  const ready = agents.filter((agent) => agent.ready).length
  const checking = agents.filter((agent) => agent.enabled && agent.checking).length
  const attention = agents.filter((agent) => agent.enabled && !agent.checking && (!agent.ready || agent.error))
  setActions('<button id="refresh-overview" class="button">' + icons.refresh + '刷新</button>')
  const body = agents.length === 0
    ? emptyState(icons.robot, '尚未配置智能体', '', { action: 'add-agent', label: '添加智能体' })
    : attention.length
      ? '<div class="panel-body overview-list">' + attention.map(overviewAgent).join('') + '</div>'
      : '<p class="panel-note">' + (checking ? '正在检查 ' + checking + ' 个智能体。' : '全部就绪。') + '</p>'
  setResults('<div class="stats">' +
      stat('智能体', agents.length) +
      stat('就绪', ready) +
      stat('会话', state.sessions) +
    '</div>' +
    '<div class="panel"><div class="panel-header"><h2>需要注意</h2><span class="muted">' + attention.length + ' 个</span></div>' +
      body +
    '</div>')
  byId('refresh-overview').onclick = (event) => withBusy(event.currentTarget, () => refreshReadiness(true))
  announce(agents.length + ' 个智能体，' + ready + ' 个就绪，' + attention.length + ' 个需要注意')
}

/* ── Runs ─────────────────────────────────────────────────────────── */

function runStatus(value) {
  const style = value === 'completed' ? ' completed' : value === 'failed' ? ' failed' : value === 'running' ? ' running' : (value === 'input_required' || value === 'permission_required') ? ' waiting' : ' canceled'
  return '<span class="status' + style + '">' + escapeHtml(runStatusLabel(value)) + '</span>'
}

function runCard(run) {
  const waiting = run.state === 'input_required' || run.state === 'permission_required'
  const progress = run.progress || {}
  return '<article class="run-card' + (waiting ? ' waiting' : '') + '"><div class="run-card-head"><div class="run-card-agent"><span class="badge">' + escapeHtml(run.protocol.toUpperCase()) + '</span><strong>' + escapeHtml(run.agentName) + '</strong></div>' + runStatus(run.state) + '</div><div class="run-task">' + escapeHtml(run.task) + '</div>' +
    (progress.phase || progress.message ? '<div class="run-progress">' + (progress.phase ? '<strong>' + escapeHtml(progress.phase) + '</strong>' : '') + (progress.message ? '<small>' + escapeHtml(progress.message) + '</small>' : '') + '</div>' : '') +
    '<div class="run-meta"><span>' + escapeHtml(shortId(run.id)) + '</span><span>' + escapeHtml(formatDuration(run)) + '</span></div>' + runDetailButton(run) + '</article>'
}

function runDetailButton(run) {
  return '<button type="button" class="button small run-detail-button" data-run-detail="' + escapeHtml(run.id) + '" aria-label="查看运行详情：' + escapeHtml(run.task) + '">查看详情</button>'
}

function runRow(run) {
  return '<tr><td><div class="agent-name"><strong>' + escapeHtml(run.agentName) + '</strong><small>' + escapeHtml(run.protocol.toUpperCase()) + '</small></div></td><td class="run-task-cell"><strong>' + escapeHtml(run.task) + '</strong><small class="run-id">' + escapeHtml(shortId(run.id)) + '</small></td><td class="run-task-cell"><strong>' + escapeHtml(run.resultSummary || run.error || '—') + '</strong><small>' + escapeHtml(run.progress && run.progress.phase || '') + '</small></td><td>' + runStatus(run.state) + '</td><td class="num">' + escapeHtml(formatDate(run.startedAt)) + '</td><td class="num">' + escapeHtml(formatDuration(run)) + '</td><td>' + runDetailButton(run) + '</td></tr>'
}

export function renderRuns() {
  const activeStates = new Set(['running', 'input_required', 'permission_required'])
  const filtered = state.runs.filter((run) => {
    const haystack = (run.task + ' ' + run.agentName + ' ' + run.id).toLowerCase()
    return haystack.indexOf(state.runSearch.toLowerCase()) >= 0 &&
      (state.runAgent === 'all' || run.agentId === state.runAgent) &&
      (state.runStatus === 'all' || run.state === state.runStatus)
  })
  const active = filtered.filter((run) => activeStates.has(run.state))
  const history = filtered.filter((run) => !activeStates.has(run.state))
  const agentOptions = state.config.agents.map((agent) => '<option value="' + escapeHtml(agent.id) + '"' + selected(state.runAgent, agent.id) + '>' + escapeHtml(agent.name) + '</option>').join('')
  setActions('<button id="refresh-runs" class="button">' + icons.refresh + '刷新</button>')
  byId('refresh-runs').onclick = (event) => withBusy(event.currentTarget, () => refreshRuns(true))

  if (!state.runs.length) {
    pageStats.innerHTML = ''
    setToolbar('')
    setResults('<div class="panel">' +
      emptyState(icons.activity, '暂无运行记录', '客户端通过网关数据接口发起任务后，进度与结果会出现在这里。') +
      '</div>')
    announce('暂无运行记录')
    return
  }

  pageStats.innerHTML =
    '<div class="run-summary">' +
      stat('当前运行', state.runStats.active) +
      stat('已完成', state.runStats.completed) +
      stat('失败', state.runStats.failed) +
      stat('记录总数', state.runTotal) +
    '</div>'
  setToolbar('runs|' + JSON.stringify(state.config.agents.map((agent) => [agent.id, agent.name])),
    '<div class="toolbar"><div class="search-box">' + icons.search + '<input id="run-search" type="search" aria-label="搜索运行记录" placeholder="搜索任务、智能体或运行 ID" value="' + escapeHtml(state.runSearch) + '"></div>' +
    '<select id="run-agent-filter" aria-label="按智能体筛选"><option value="all">全部智能体</option>' + agentOptions + '</select>' +
    '<select id="run-status-filter" aria-label="按运行状态筛选"><option value="all">全部状态</option><option value="running"' + selected(state.runStatus, 'running') + '>运行中</option><option value="input_required"' + selected(state.runStatus, 'input_required') + '>等待输入</option><option value="permission_required"' + selected(state.runStatus, 'permission_required') + '>等待授权</option><option value="completed"' + selected(state.runStatus, 'completed') + '>已完成</option><option value="failed"' + selected(state.runStatus, 'failed') + '>失败</option><option value="canceled"' + selected(state.runStatus, 'canceled') + '>已取消</option></select></div>')
  setResults((state.runTotal > state.runs.length ? '<p class="muted">已载入最近 ' + state.runs.length + ' 条记录，筛选仅作用于这些记录。</p>' : '') +
    '<section class="run-section"><div class="run-section-title"><h2>当前运行</h2><span>' + active.length + ' 项</span></div>' +
      (active.length ? '<div class="run-live-grid">' + active.map(runCard).join('') + '</div>' : '<div class="panel">' + emptyState(icons.activity, '当前没有任务') + '</div>') +
    '</section>' +
    '<section class="run-section"><div class="run-section-title"><h2>历史记录</h2><span>' + history.length + ' 项</span></div>' +
      '<div class="table-wrap"><table class="run-table"><thead><tr><th>智能体</th><th>任务</th><th>结果</th><th>状态</th><th class="num">开始时间</th><th class="num">耗时</th><th>操作</th></tr></thead><tbody>' +
      (history.length ? history.map(runRow).join('') : '<tr><td colspan="7" class="empty">没有符合条件的历史记录。</td></tr>') +
      '</tbody></table></div></section>')
  bindSearch('run-search', (value) => { state.runSearch = value; renderRuns() })
  byId('run-agent-filter').onchange = (event) => { state.runAgent = event.target.value; renderRuns() }
  byId('run-status-filter').onchange = (event) => { state.runStatus = event.target.value; renderRuns() }
  announce(active.length + ' 项当前运行，' + history.length + ' 项历史记录')
}

function detailItem(label, value) {
  return '<div class="run-detail-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
}

export async function openRunDrawer(id) {
  openDrawer('运行详情', '<p role="status">正在加载运行详情…</p>', '', null)
  drawerForm.setAttribute('aria-busy', 'true')
  const version = getDrawerVersion()
  let run
  try {
    run = await api('/v1/admin/runs/' + encodeURIComponent(id))
  } catch (error) {
    if (version === getDrawerVersion()) {
      drawerForm.removeAttribute('aria-busy')
      drawerForm.innerHTML = '<p class="form-error" role="alert">' + escapeHtml(error.message) + '</p>'
    }
    return
  }
  if (version !== getDrawerVersion()) return
  const artifacts = run.artifacts && run.artifacts.length
    ? '<div class="run-detail-block"><h3>产物</h3><div class="overview-list">' + run.artifacts.map((artifact) => '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(artifact.name || artifact.filename || artifact.id || '未命名产物') + '</strong><small>' + escapeHtml(artifact.mediaType || artifact.url || '') + '</small></div></div>').join('') + '</div></div>'
    : ''
  const body = '<div class="run-detail-grid">' +
    detailItem('智能体', run.agentName) + detailItem('状态', runStatusLabel(run.state)) +
    detailItem('开始时间', formatDate(run.startedAt)) + detailItem('耗时', formatDuration(run)) +
    detailItem('协议', run.protocol.toUpperCase()) + detailItem('运行 ID', run.id) +
    detailItem('当前阶段', run.progress && run.progress.phase || '—') + detailItem('输入附件', run.inputAttachmentCount || 0) + detailItem('产物', run.artifactCount || 0) +
    '</div><div class="run-detail-block"><h3>用户任务</h3><pre class="run-detail-code">' + escapeHtml(run.task) + (run.taskTruncated ? '\n\n[记录已截断]' : '') + '</pre></div>' +
    (run.progress && run.progress.message ? '<div class="run-detail-block"><h3>最近进度</h3><pre class="run-detail-code">' + escapeHtml(run.progress.message) + '</pre></div>' : '') +
    (run.output ? '<div class="run-detail-block"><h3>智能体结果</h3><pre class="run-detail-code">' + escapeHtml(run.output) + '</pre></div>' : '') +
    (run.error ? '<div class="run-detail-block"><h3>错误</h3><pre class="run-detail-code">' + escapeHtml(run.error) + '</pre></div>' : '') + artifacts
  byId('drawer-title').textContent = '运行详情 · ' + run.agentName
  drawerForm.innerHTML = body
  drawerForm.removeAttribute('aria-busy')
}

/* ── Agents ───────────────────────────────────────────────────────── */

function agentRow(agent, live) {
  const statusAgent = live || { ready: false, enabled: agent.enabled, checking: true }
  return '<tr><td><div class="agent-name"><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.id) + '</small>' +
    (statusAgent.error && agent.enabled ? '<span class="error-detail">' + escapeHtml(localizeError(statusAgent.error)) + '</span>' : '') +
    '</div></td><td><span class="badge">' + escapeHtml(agent.protocol.toUpperCase()) + '</span></td><td>' + escapeHtml(agent.driver || '—') + '</td><td>' + statusMarkup(statusAgent) + '</td><td>' + escapeHtml(agent.workspace || '—') + '</td><td>' + escapeHtml(permissionLabel(agent.permissionPolicy)) + '</td><td><div class="row-actions"><button class="button small" data-agent-edit="' + escapeHtml(agent.id) + '">编辑</button><button class="button small danger" data-agent-delete="' + escapeHtml(agent.id) + '">删除</button></div></td></tr>'
}

function renderAgents() {
  setActions('<button id="refresh-agents" class="button">' + icons.refresh + '刷新</button><button id="add-agent" class="button primary">' + icons.plus + '添加智能体</button>')
  byId('refresh-agents').onclick = (event) => withBusy(event.currentTarget, () => refreshReadiness(true))
  byId('add-agent').onclick = () => openAgentDrawer()

  if (!state.config.agents.length) {
    setToolbar('')
    setResults('<div class="panel">' +
      emptyState(icons.robot, '尚未配置智能体', '智能体是网关转发任务的执行端，支持本地 ACP 进程与远程 A2A 服务。', { action: 'add-agent', label: '添加智能体' }) +
      '</div>')
    announce('尚未配置智能体')
    return
  }

  const lookup = readinessById()
  const rows = state.config.agents.filter((agent) => {
    const live = agentReadiness(agent, lookup)
    const haystack = (agent.name + ' ' + agent.id + ' ' + (agent.description || '')).toLowerCase()
    const status = !lookup.has(agent.id) ? 'checking' : live.ready ? 'ready' : agent.enabled ? 'failed' : 'disabled'
    return haystack.indexOf(state.search.toLowerCase()) >= 0 &&
      (state.protocol === 'all' || agent.protocol === state.protocol) &&
      (state.status === 'all' || status === state.status)
  })
  setToolbar('agents',
    '<div class="toolbar"><div class="search-box">' + icons.search + '<input id="agent-search" type="search" aria-label="搜索智能体" placeholder="搜索智能体" value="' + escapeHtml(state.search) + '"></div>' +
    '<select id="protocol-filter" aria-label="按协议筛选"><option value="all">全部协议</option><option value="acp"' + selected(state.protocol, 'acp') + '>ACP</option><option value="a2a"' + selected(state.protocol, 'a2a') + '>A2A</option></select>' +
    '<select id="status-filter" aria-label="按就绪状态筛选"><option value="all">全部状态</option><option value="ready"' + selected(state.status, 'ready') + '>就绪</option><option value="failed"' + selected(state.status, 'failed') + '>不可用</option><option value="disabled"' + selected(state.status, 'disabled') + '>已禁用</option></select></div>')
  setResults('<div class="table-wrap"><table class="agent-table"><thead><tr><th>智能体</th><th>协议</th><th>驱动</th><th>状态</th><th>工作区</th><th>权限策略</th><th>操作</th></tr></thead><tbody>' +
    (rows.length ? rows.map((agent) => agentRow(agent, lookup.get(agent.id))).join('') : '<tr><td colspan="7" class="empty">没有符合条件的智能体。</td></tr>') +
    '</tbody></table></div>')
  bindSearch('agent-search', (value) => { state.search = value; renderAgents() })
  byId('protocol-filter').onchange = (event) => { state.protocol = event.target.value; renderAgents() }
  byId('status-filter').onchange = (event) => { state.status = event.target.value; renderAgents() }
  announce(rows.length + ' 个智能体，' + rows.filter((agent) => agentReadiness(agent, lookup).ready).length + ' 个就绪')
}

/* ── Workspaces ───────────────────────────────────────────────────── */

function withinRoot(root, workspace) {
  const base = root.replace(/\/+$/, '')
  return workspace === base || workspace.startsWith(base + '/')
}

export function workspaceDependents(index) {
  const roots = state.config.workspaceRoots
  return state.config.agents.filter((agent) => agent.protocol === 'acp' && agent.workspace &&
    withinRoot(roots[index], agent.workspace) &&
    !roots.some((root, other) => other !== index && withinRoot(root, agent.workspace)))
}

function workspaceRow(root, index, total) {
  const usedBy = state.config.agents.filter((agent) => agent.protocol === 'acp' && agent.workspace && withinRoot(root, agent.workspace)).map((agent) => escapeHtml(agent.name))
  const blocked = workspaceDependents(index).length > 0
  return '<div class="list-row"><div class="list-row-main"><strong class="path">' + escapeHtml(root) + '</strong>' +
    '<small>' + (usedBy.length ? '使用中：' + usedBy.join('、') : '没有智能体使用') + '</small></div>' +
    '<div class="row-actions"><button class="button small" data-workspace-edit="' + index + '">编辑</button>' +
    '<button class="button small danger" data-workspace-delete="' + index + '"' +
    (total === 1 ? ' disabled title="至少保留一个工作区"' : blocked ? ' disabled title="请先修改使用此工作区的智能体配置"' : '') + '>删除</button></div></div>'
}

function renderWorkspaces() {
  setActions('<button id="add-workspace" class="button primary">' + icons.plus + '添加工作区</button>')
  byId('add-workspace').onclick = () => openWorkspaceDrawer()
  const roots = state.config.workspaceRoots || []
  setResults('<div class="panel"><div class="panel-header"><h2>允许的根目录</h2><span class="muted">' + roots.length + ' 个</span></div>' +
    (roots.length
      ? '<div class="panel-body workspace-list">' + roots.map((root, index) => workspaceRow(root, index, roots.length)).join('') + '</div>'
      : emptyState(icons.folder, '尚未配置工作区', '', { action: 'add-workspace', label: '添加工作区' })) +
    '</div>')
  announce(roots.length + ' 个工作区')
}

/* ── API keys ─────────────────────────────────────────────────────── */

function keyRow(key) {
  const scope = key.scope.allAgents ? '全部智能体' : (key.scope.agentIds.length ? key.scope.agentIds.join(', ') : '未授权智能体')
  const id = escapeHtml(key.id)
  const toggleLabel = key.enabled ? '禁用密钥' : '启用密钥'
  return '<tr><td><div class="agent-name"><strong>' + escapeHtml(key.name) + '</strong>' + (key.legacy ? '<span class="badge">旧版</span>' : '') + '</div></td>' +
    '<td>' + (key.enabled ? '<span class="status ready">已启用</span>' : '<span class="status">已禁用</span>') + '</td>' +
    '<td data-label="API 密钥"><div class="key-secret-cell"><code>••••' + escapeHtml(key.suffix) + '</code><button class="key-copy-button" data-key-action="copy" data-key-id="' + id + '" aria-label="复制完整密钥" title="复制完整密钥">' + icons.copy + '</button></div></td>' +
    '<td data-label="授权范围"><span class="key-scope">' + escapeHtml(scope) + '</span></td>' +
    '<td data-label="最后使用"><span class="key-last-used">' + escapeHtml(key.lastUsedAt ? formatDate(key.lastUsedAt) : '从未使用') + '</span></td>' +
    '<td><div class="key-actions"><button class="key-icon-button' + (key.enabled ? ' danger-action' : '') + '" data-key-action="toggle" data-key-id="' + id + '" aria-label="' + toggleLabel + '" title="' + toggleLabel + '">' + (key.enabled ? icons.disable : icons.enable) + '</button><button class="key-icon-button" data-key-action="rename" data-key-id="' + id + '" aria-label="重命名" title="重命名">' + icons.edit + '</button><button class="key-icon-button" data-key-menu="' + id + '" aria-label="更多操作" title="更多操作" aria-expanded="false" aria-haspopup="menu" aria-controls="key-action-menu">' + icons.more + '</button></div></td></tr>'
}

function renderApiKeys() {
  closeKeyActionMenu()
  setActions('<button id="create-key" class="button primary">' + icons.plus + '创建 API 密钥</button>')
  setResults(state.apiKeys.length
    ? '<div class="table-wrap key-table-wrap"><table class="key-table"><thead><tr><th>名称</th><th>状态</th><th>API 密钥</th><th>授权范围</th><th>最后使用</th><th>操作</th></tr></thead><tbody>' + state.apiKeys.map(keyRow).join('') + '</tbody></table></div>'
    : '<div class="panel">' + emptyState(icons.key, '尚未创建 API 密钥', '客户端调用网关数据接口时需要携带密钥。', { action: 'create-key', label: '创建 API 密钥' }) + '</div>')
  byId('create-key').onclick = () => openKeyDrawer()
  announce(state.apiKeys.length + ' 个 API 密钥')
}

function emptyState(icon, title, text, cta) {
  return '<div class="empty-state">' + icon + '<strong>' + escapeHtml(title) + '</strong>' +
    (text ? '<span>' + escapeHtml(text) + '</span>' : '') +
    (cta ? '<button type="button" class="button primary" data-empty-action="' + escapeHtml(cta.action) + '">' + icons.plus + escapeHtml(cta.label) + '</button>' : '') +
    '</div>'
}

function bindSearch(id, apply) {
  const input = byId(id)
  if (input.dataset.searchBound) return
  input.dataset.searchBound = 'true'
  input.addEventListener('compositionstart', () => { input.dataset.composing = 'true' })
  input.addEventListener('compositionend', () => { delete input.dataset.composing; apply(input.value) })
  input.addEventListener('input', (event) => {
    if (!event.isComposing && !input.dataset.composing) apply(input.value)
  })
}

/* ── Settings ─────────────────────────────────────────────────────── */

/* 三节的划分依据是「改它会不会影响其他客户端」：运行参数写进配置文件、对所有客户端生效；
   外观只写 localStorage；账户只关乎当前管理员。两句节说明因此必须保留。 */
function renderSettings() {
  const sessionTtlHours = Math.round((state.config.sessionTtlMs || 24 * 60 * 60 * 1000) / 3_600_000)
  const promptTimeoutMinutes = Math.round((state.config.promptTimeoutMs || 30 * 60 * 1000) / 60_000)
  const cleanupIntervalSeconds = Math.round((state.config.cleanupIntervalMs || 60_000) / 1000)
  const theme = localStorage.getItem('agent-nexus-theme') || 'system'
  setActions('<button type="submit" form="settings-form" class="button primary">保存更改</button>')
  setResults('<form id="settings-form" class="settings-layout">' +
    '<section class="settings-section settings-runtime"><div class="settings-section-heading"><h2>运行参数</h2>' +
    '<p class="settings-note">写入网关配置文件，对所有客户端生效。</p></div>' +
    '<div class="settings-fields">' +
    '<div class="field"><label for="session-ttl-hours">会话空闲有效期（小时）</label><input id="session-ttl-hours" name="sessionTtlHours" type="number" min="1" max="720" step="1" value="' + escapeHtml(sessionTtlHours) + '"><small class="field-help">无活动超过该时长后释放会话。默认 24 小时。</small></div>' +
    '<div class="field"><label for="prompt-timeout-minutes">单次 ACP 任务超时（分钟）</label><input id="prompt-timeout-minutes" name="promptTimeoutMinutes" type="number" min="1" max="1440" step="1" value="' + escapeHtml(promptTimeoutMinutes) + '"><small class="field-help">超时后任务记为失败并释放资源。默认 30 分钟。</small></div>' +
    '<div class="field"><label for="cleanup-interval-seconds">清理任务周期（秒）</label><input id="cleanup-interval-seconds" name="cleanupIntervalSeconds" type="number" min="5" max="3600" step="1" value="' + escapeHtml(cleanupIntervalSeconds) + '"><small class="field-help">扫描空闲会话与过期记录的间隔。默认 60 秒。</small></div>' +
    '</div>' +
    '</section>' +
    '<section class="settings-section settings-appearance"><div class="settings-section-heading"><h2>外观</h2>' +
    '<p class="settings-note">仅影响当前浏览器。</p></div>' +
    '<div class="settings-fields"><div class="field"><label for="theme-select">界面主题</label>' +
    '<select id="theme-select"><option value="system"' + selected(theme, 'system') + '>跟随系统</option><option value="light"' + selected(theme, 'light') + '>浅色</option><option value="dark"' + selected(theme, 'dark') + '>深色</option></select>' +
    '</div></div></section>' +
    '<section class="settings-section settings-account"><div class="settings-section-heading"><h2>账户</h2></div>' +
    '<div class="settings-account-row"><div class="settings-account-copy"><strong>控制台密码</strong><p>用于登录当前管理控制台。</p></div>' +
    '<div class="settings-account-fields"><div class="field"><label for="settings-current-password">当前密码</label><input id="settings-current-password" name="currentPassword" type="password" autocomplete="current-password"></div>' +
    '<div class="field"><label for="settings-new-password">新密码</label><input id="settings-new-password" name="newPassword" type="password" minlength="12" autocomplete="new-password"></div>' +
    '<div class="field"><label for="settings-confirm-password">确认新密码</label><input id="settings-confirm-password" name="confirmPassword" type="password" minlength="12" autocomplete="new-password"></div></div></div>' +
    '</section>' +
    '<p class="form-error settings-form-error" data-form-error role="alert"></p>' +
    '</form>')
  const form = byId('settings-form')
  form.onsubmit = async (event) => {
    event.preventDefault()
    await withBusy(event.submitter || form.querySelector('[type="submit"]'), async () => {
      const error = form.querySelector('[data-form-error]')
      error.textContent = ''
      const data = new FormData(form)
      const currentPassword = String(data.get('currentPassword') || '')
      const newPassword = String(data.get('newPassword') || '')
      const confirmPassword = String(data.get('confirmPassword') || '')
      const changingPassword = Boolean(currentPassword || newPassword || confirmPassword)
      const values = {
        sessionTtlMs: Number(data.get('sessionTtlHours')) * 3_600_000,
        promptTimeoutMs: Number(data.get('promptTimeoutMinutes')) * 60_000,
        cleanupIntervalMs: Number(data.get('cleanupIntervalSeconds')) * 1000
      }
      try {
        state.config = await api('/v1/admin/config/runtime', { method: 'PUT', body: values })
        if (changingPassword) {
          if (!currentPassword || !newPassword || !confirmPassword) throw new Error('请完整填写密码修改信息')
          if (newPassword !== confirmPassword) throw new Error('两次输入的控制台密码不一致')
          await api('/v1/admin/password', { method: 'PUT', body: { currentPassword, newPassword, confirmPassword } })
          showLogin()
          toast('控制台密码已修改，请重新登录。')
          return
        }
        toast('运行参数已保存并立即生效')
      } catch (reason) { error.textContent = reason.message }
    })
  }
  byId('theme-select').onchange = (event) => {
    localStorage.setItem('agent-nexus-theme', event.target.value)
    applyTheme(event.target.value)
  }
}

/* ── Drawers: agent / workspace / key / password ──────────────────── */

export function openAgentDrawer(agent) {
  const editing = Boolean(agent)
  const current = agent || { protocol: 'acp', enabled: true, permissionPolicy: 'ask', permissionTimeoutMs: 900000, timeoutMs: 60000 }
  const permissionTimeoutSeconds = Math.max(1, Math.round(Number(current.permissionTimeoutMs || 900000) / 1000))
  const requestTimeoutSeconds = Math.max(1, Math.round(Number(current.timeoutMs || 60000) / 1000))
  const drivers = state.config.driverKinds.map((driver) => '<option value="' + escapeHtml(driver) + '"' + selected(current.driver || state.config.driverKinds[0], driver) + '>' + escapeHtml(driver) + '</option>').join('')
  const roots = state.config.workspaceRoots.map((root) => '<option value="' + escapeHtml(root) + '"></option>').join('')
  const body =
    '<div class="field"><label for="f-id">智能体 ID</label><input id="f-id" name="id" value="' + escapeHtml(current.id || '') + '" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" required' + (editing ? ' disabled' : '') + '></div>' +
    '<div class="field-row"><div class="field"><label for="f-protocol">协议</label><select id="f-protocol" name="protocol"><option value="acp"' + selected(current.protocol, 'acp') + '>ACP</option><option value="a2a"' + selected(current.protocol, 'a2a') + '>A2A</option></select></div><div class="field"><span class="field-spacer" aria-hidden="true">&nbsp;</span><label class="checkbox"><input name="enabled" type="checkbox"' + checked(current.enabled) + '>启用</label></div></div>' +
    '<div class="field"><label for="f-name">名称</label><input id="f-name" name="name" value="' + escapeHtml(current.name || '') + '" required></div>' +
    '<div class="field"><label for="f-description">描述</label><textarea id="f-description" name="description">' + escapeHtml(current.description || '') + '</textarea></div>' +
    '<div data-protocol-section="acp"><div class="field"><label for="f-driver">驱动</label><select id="f-driver" name="driver">' + drivers + '</select></div><div class="field"><label for="f-workspace">工作区</label><input id="f-workspace" name="workspace" list="workspace-roots" value="' + escapeHtml(current.workspace || state.config.workspaceRoots[0] || '') + '" required><datalist id="workspace-roots">' + roots + '</datalist></div><div class="field-row"><div class="field"><label for="f-permissionPolicy">权限策略</label><select id="f-permissionPolicy" name="permissionPolicy"><option value="ask"' + selected(current.permissionPolicy, 'ask') + '>询问</option><option value="allow"' + selected(current.permissionPolicy, 'allow') + '>始终允许</option><option value="deny"' + selected(current.permissionPolicy, 'deny') + '>拒绝</option></select></div><div class="field"><label for="f-permissionTimeoutMs">权限确认超时（秒）</label><input id="f-permissionTimeoutMs" name="permissionTimeoutMs" type="number" min="1" max="86400" step="1" value="' + escapeHtml(permissionTimeoutSeconds) + '"><small class="field-help">默认 900 秒，最长 24 小时；选择「始终允许」时不生效。</small></div></div></div>' +
    '<div data-protocol-section="a2a"><div class="field"><label for="f-agentCardUrl">Agent Card URL</label><input id="f-agentCardUrl" name="agentCardUrl" type="url" value="' + escapeHtml(current.agentCardUrl || '') + '" placeholder="http://agent.local:8080/.well-known/agent-card.json" required><small class="field-help">调用地址与能力从 Card 自动发现。</small></div><div class="field-row"><div class="field"><label for="f-preferredTransport">首选传输</label><select id="f-preferredTransport" name="preferredTransport"><option value="auto"' + selected(current.preferredTransport || 'auto', 'auto') + '>自动（按 Card）</option><option value="jsonrpc"' + selected(current.preferredTransport, 'jsonrpc') + '>JSON-RPC</option><option value="http-json"' + selected(current.preferredTransport, 'http-json') + '>HTTP+JSON</option></select></div><div class="field"><label for="f-authType">认证方式</label><select id="f-authType" name="authType"><option value="none"' + selected(current.auth && current.auth.type || 'none', 'none') + '>无认证</option><option value="bearer"' + selected(current.auth && current.auth.type, 'bearer') + '>Bearer Token</option><option value="header"' + selected(current.auth && current.auth.type, 'header') + '>自定义请求头</option></select></div></div><div class="field" data-auth-header><label for="f-authHeaderName">请求头名称</label><input id="f-authHeaderName" name="authHeaderName" value="' + escapeHtml(current.auth && current.auth.headerName || '') + '" placeholder="X-API-Key"></div><div class="field" data-auth-value><label data-auth-value-label for="f-authValue">认证凭据</label><input id="f-authValue" name="authValue" type="password" autocomplete="off" placeholder="' + (editing && current.auth && current.auth.configured ? '留空以保留当前凭据' : '') + '"></div><div class="field"><label for="f-timeoutMs">请求超时（秒）</label><input id="f-timeoutMs" name="timeoutMs" type="number" min="1" max="1800" step="1" value="' + escapeHtml(requestTimeoutSeconds) + '"><small class="field-help">单次请求上限。默认 60 秒，最大 1800 秒。</small></div></div>'
  openDrawer(editing ? '编辑智能体' : '添加智能体', body, editing ? '保存修改' : '添加智能体', async (form, isCurrent) => {
    const data = new FormData(form)
    const protocol = data.get('protocol')
    const id = editing ? current.id : String(data.get('id') || '').trim().toLowerCase()
    const payload = {
      protocol,
      name: String(data.get('name') || '').trim(),
      description: String(data.get('description') || '').trim(),
      enabled: data.get('enabled') === 'on'
    }
    if (protocol === 'acp') {
      payload.driver = data.get('driver')
      payload.workspace = String(data.get('workspace') || '').trim()
      payload.permissionPolicy = data.get('permissionPolicy')
      payload.permissionTimeoutMs = Number(data.get('permissionTimeoutMs')) * 1000
    } else {
      payload.agentCardUrl = String(data.get('agentCardUrl') || '').trim()
      payload.preferredTransport = data.get('preferredTransport')
      payload.authType = data.get('authType')
      payload.authHeaderName = String(data.get('authHeaderName') || '').trim()
      const authValue = String(data.get('authValue') || '')
      if (authValue) payload.authValue = authValue
      payload.timeoutMs = Number(data.get('timeoutMs')) * 1000
    }
    await api('/v1/admin/agents/' + encodeURIComponent(id), { method: 'PUT', body: payload })
    if (isCurrent()) closeDrawer()
    await loadAll(true)
    render()
    toast(editing ? '智能体已更新' : '智能体已添加')
  })
  const protocolSelect = drawerFormElements().protocol
  const authSelect = drawerFormElements().authType
  const sync = () => {
    document.querySelectorAll('#drawer-form [data-protocol-section]').forEach((section) => {
      section.classList.toggle('hidden', section.dataset.protocolSection !== protocolSelect.value)
      section.querySelectorAll('input,select,textarea').forEach((field) => { field.disabled = section.classList.contains('hidden') })
    })
    if (protocolSelect.value === 'a2a') {
      const auth = authSelect.value
      document.querySelector('#drawer-form [data-auth-header]').classList.toggle('hidden', auth !== 'header')
      document.querySelector('#drawer-form [data-auth-value]').classList.toggle('hidden', auth === 'none')
      document.querySelector('#drawer-form [data-auth-value-label]').textContent = auth === 'bearer' ? 'Bearer Token' : '认证凭据'
    }
  }
  protocolSelect.onchange = sync
  authSelect.onchange = sync
  sync()
}

function drawerFormElements() {
  return byId('drawer-form').elements
}

export function openWorkspaceDrawer(index) {
  const editing = Number.isInteger(index)
  const current = editing ? state.config.workspaceRoots[index] : ''
  openDrawer(editing ? '编辑工作区' : '添加工作区', '<div class="field"><label for="f-path">允许访问的根目录</label><input id="f-path" name="path" value="' + escapeHtml(current) + '" required></div>', editing ? '保存修改' : '添加工作区', async (form, isCurrent) => {
    const roots = state.config.workspaceRoots.slice()
    const value = String(new FormData(form).get('path') || '').trim()
    if (editing) roots[index] = value
    else roots.push(value)
    const result = await api('/v1/admin/config/workspace-roots', { method: 'PUT', body: { workspaceRoots: roots } })
    state.config = result
    if (isCurrent()) closeDrawer()
    render()
    toast(editing ? '工作区已更新' : '工作区已添加')
  })
}

function agentScopeOption(agent, selected = false) {
  return '<label class="checkbox"><input type="checkbox" name="agentId" value="' + escapeHtml(agent.id) + '"' + checked(selected) + '><span class="scope-name">' + escapeHtml(agent.name) + '</span><span class="muted">(' + escapeHtml(agent.protocol.toUpperCase()) + ')</span></label>'
}

export function openKeyDrawer() {
  const scopeRows = state.config.agents.map((agent) => agentScopeOption(agent)).join('')
  const body = '<div class="field"><label for="f-name">名称</label><input id="f-name" name="name" required autocomplete="off" placeholder="例如：开发客户端"></div><div class="field"><label class="checkbox"><input id="all-agents" name="allAgents" type="checkbox" checked>允许访问全部智能体</label></div><div id="agent-scope" class="agent-scope hidden">' + (scopeRows || '<span class="muted">尚未配置智能体。</span>') + '</div><div class="field"><label for="f-customSecret">自定义密钥（可选）</label><input id="f-customSecret" name="customSecret" minlength="16" autocomplete="off" placeholder="留空则自动生成 nx_sk_ 密钥"></div>'
  openDrawer('创建 API 密钥', body, '创建 API 密钥', async (form, isCurrent) => {
    const data = new FormData(form)
    const allAgents = data.get('allAgents') === 'on'
    const agentIds = data.getAll('agentId').map(String)
    if (!allAgents && !agentIds.length) throw new Error('请至少选择一个智能体')
    const customSecret = String(data.get('customSecret') || '').trim()
    const result = await api('/v1/admin/api-keys', {
      method: 'POST',
      body: {
        name: String(data.get('name') || '').trim(),
        scope: { allAgents, agentIds },
        customSecret: customSecret || undefined
      }
    })
    state.apiKeys.unshift(result.key)
    if (isCurrent()) showSecret('API 密钥已创建', result.secret)
    else toast('API 密钥已创建，可在密钥列表中显示或复制')
    render()
  })
  const all = byId('all-agents')
  all.onchange = () => byId('agent-scope').classList.toggle('hidden', all.checked)
}

export function showSecret(title, secret) {
  openDrawer(title, '<div class="secret-box"><span class="muted">请立即复制；之后可在密钥列表中再次显示。</span><code class="secret-value">' + escapeHtml(secret) + '</code><button class="button" type="button" id="copy-secret">' + icons.copy + '复制</button></div>', '', null)
  byId('copy-secret').onclick = async () => {
    try {
      await copySecret(secret)
      toast('API 密钥已复制')
    } catch (error) { toast(error.message, true) }
  }
}

export async function copySecret(secret) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(secret)
      return
    } catch {}
  }
  const temporary = document.createElement('textarea')
  temporary.value = secret
  temporary.setAttribute('readonly', '')
  temporary.style.position = 'fixed'
  temporary.style.opacity = '0'
  temporary.style.pointerEvents = 'none'
  const previousFocus = document.activeElement
  const dialog = byId('drawer')
  ;(dialog.classList.contains('hidden') ? document.body : dialog).appendChild(temporary)
  temporary.select()
  const copied = document.execCommand('copy')
  temporary.remove()
  previousFocus?.focus({ preventScroll: true })
  if (!copied) throw new Error('无法自动复制，请在“显示完整密钥”中手动复制。')
}

export function openPasswordDrawer() {
  openDrawer('修改密码', '<div class="field"><label for="f-currentPassword">当前密码</label><input id="f-currentPassword" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="f-newPassword">新密码</label><input id="f-newPassword" name="newPassword" type="password" minlength="12" autocomplete="new-password" required></div><div class="field"><label for="f-confirmPassword">确认新密码</label><input id="f-confirmPassword" name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required></div>', '修改密码', async (form) => {
    const data = new FormData(form)
    await api('/v1/admin/password', { method: 'PUT', body: { currentPassword: String(data.get('currentPassword') || ''), newPassword: String(data.get('newPassword') || ''), confirmPassword: String(data.get('confirmPassword') || '') } })
    closeDrawer()
    showLogin()
    toast('控制台密码已修改，请重新登录。')
  })
}

export function openKeyScopeDrawer(key) {
  const selectedIds = new Set(key.scope.agentIds || [])
  const scopeRows = state.config.agents.map((agent) => agentScopeOption(agent, selectedIds.has(agent.id))).join('')
  const body = '<div class="field"><label class="checkbox"><input id="edit-all-agents" name="allAgents" type="checkbox"' + checked(key.scope.allAgents) + '>允许访问全部智能体</label></div><div id="edit-agent-scope" class="agent-scope' + (key.scope.allAgents ? ' hidden' : '') + '">' + (scopeRows || '<span class="muted">尚未配置智能体。</span>') + '</div>'
  openDrawer('编辑 API 密钥授权范围', body, '保存授权范围', async (form, isCurrent) => {
    const data = new FormData(form)
    const allAgents = data.get('allAgents') === 'on'
    const agentIds = data.getAll('agentId').map(String)
    if (!allAgents && !agentIds.length) throw new Error('请至少选择一个智能体')
    await api('/v1/admin/api-keys/' + encodeURIComponent(key.id), { method: 'PATCH', body: { scope: { allAgents, agentIds } } })
    if (isCurrent()) closeDrawer()
    await reloadKeys()
    toast('API 密钥授权范围已更新')
  })
  const all = byId('edit-all-agents')
  all.onchange = () => byId('edit-agent-scope').classList.toggle('hidden', all.checked)
}

export function openRenameKeyDrawer(key) {
  openDrawer('重命名 API 密钥', '<div class="field"><label for="f-key-name">名称</label><input id="f-key-name" name="name" value="' + escapeHtml(key.name) + '" required autocomplete="off"></div>', '保存名称', async (form, isCurrent) => {
    const name = String(new FormData(form).get('name') || '').trim()
    if (name === key.name) { closeDrawer(); return }
    await api('/v1/admin/api-keys/' + encodeURIComponent(key.id), { method: 'PATCH', body: { name } })
    if (isCurrent()) closeDrawer()
    await reloadKeys()
    toast('API 密钥已重命名')
  })
  const input = byId('f-key-name')
  if (input) setTimeout(() => input.select(), 0)
}

export async function reloadKeys() {
  const value = await api('/v1/admin/api-keys')
  state.apiKeys = value.apiKeys || []
  render()
}

/* ── Key action menu ──────────────────────────────────────────────── */

let menuAnchor = null

export function handleKeyMenuKeydown(event) {
  if (keyActionMenu.classList.contains('hidden')) return
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault()
    closeKeyActionMenu(true)
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const items = Array.from(keyActionMenu.querySelectorAll('[role="menuitem"]'))
  const index = items.indexOf(document.activeElement)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
    (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items.forEach((item, position) => { item.tabIndex = position === next ? 0 : -1 })
  items[next].focus({ preventScroll: true })
}

export function toggleKeyActionMenu(anchor, id) {
  if (!keyActionMenu.classList.contains('hidden') && keyActionMenu.dataset.keyId === id) {
    closeKeyActionMenu(true)
    return
  }
  closeKeyActionMenu()
  menuAnchor = anchor
  keyActionMenu.dataset.keyId = id
  keyActionMenu.innerHTML =
    '<button type="button" role="menuitem" data-key-action="reveal" data-key-id="' + escapeHtml(id) + '">' + icons.reveal + '<span>显示完整密钥</span></button>' +
    '<button type="button" role="menuitem" data-key-action="scope" data-key-id="' + escapeHtml(id) + '">' + icons.scope + '<span>编辑授权范围</span></button>' +
    '<button type="button" role="menuitem" data-key-action="regenerate" data-key-id="' + escapeHtml(id) + '">' + icons.regenerate + '<span>重新生成密钥</span></button>' +
    '<button type="button" role="menuitem" class="danger-text" data-key-action="delete" data-key-id="' + escapeHtml(id) + '">' + icons.trash + '<span>删除密钥</span></button>'
  keyActionMenu.classList.remove('hidden')
  anchor.setAttribute('aria-expanded', 'true')
  const anchorRect = anchor.getBoundingClientRect()
  const menuRect = keyActionMenu.getBoundingClientRect()
  const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, anchorRect.right - menuRect.width))
  const below = anchorRect.bottom + 6
  const top = below + menuRect.height <= window.innerHeight - 8
    ? below
    : Math.max(8, anchorRect.top - menuRect.height - 6)
  keyActionMenu.style.left = left + 'px'
  keyActionMenu.style.top = top + 'px'
  const items = Array.from(keyActionMenu.querySelectorAll('[role="menuitem"]'))
  items.forEach((item, index) => { item.tabIndex = index === 0 ? 0 : -1 })
  items[0]?.focus({ preventScroll: true })
}

export function closeKeyActionMenu(restore = false) {
  keyActionMenu.classList.add('hidden')
  keyActionMenu.innerHTML = ''
  keyActionMenu.dataset.keyId = ''
  document.querySelectorAll('[data-key-menu][aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'))
  if (restore === true && menuAnchor?.isConnected) menuAnchor.focus({ preventScroll: true })
  menuAnchor = null
}
