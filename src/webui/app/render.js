import { state, pageMeta } from './state.js'
import { byId, content, actions, description, keyActionMenu, escapeHtml, selected, checked } from './dom.js'
import { icons } from './icons.js'
import { api, localizeError } from './api.js'
import { toast, runAction } from './toast.js'
import { openDrawer, closeDrawer } from './drawer.js'
import { showLogin } from './screens.js'
import { loadAll, refreshRuns, refreshReadiness } from './data.js'
import { shortId, formatDate, formatDuration, runStatusLabel, permissionLabel } from './format.js'

export function render() {
  const meta = pageMeta[state.page]
  byId('page-title').textContent = meta[0]
  description.textContent = meta[1]
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === state.page)
  })
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

export function readinessRows() {
  const readiness = new Map(state.readiness.map((agent) => [agent.id, agent]))
  return state.config.agents.map((agent) => readiness.get(agent.id) || {
    id: agent.id,
    name: agent.name,
    protocol: agent.protocol,
    driver: agent.driver,
    enabled: agent.enabled,
    ready: false,
    checking: true
  })
}

function overviewAgent(agent) {
  return '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(agent.name) + '</strong><small>' +
    escapeHtml(agent.protocol.toUpperCase() + (agent.driver ? ' · ' + agent.driver : '')) +
    (agent.error ? ' · ' + escapeHtml(localizeError(agent.error)) : '') + '</small></div>' + statusMarkup(agent) + '</div>'
}

function renderOverview() {
  const agents = readinessRows()
  const ready = agents.filter((agent) => agent.ready).length
  actions.innerHTML = '<button id="refresh-overview" class="button">' + icons.refresh + '刷新</button>'
  content.innerHTML =
    '<div class="stats">' +
      stat('智能体', agents.length) +
      stat('就绪', ready) +
      stat('会话', state.sessions) +
    '</div>' +
    '<div class="panel"><div class="panel-header"><h2>智能体</h2><span class="muted">每 20 秒自动检查</span></div>' +
      (agents.length
        ? '<div class="panel-body overview-list">' + agents.map(overviewAgent).join('') + '</div>'
        : emptyState(icons.robot, '尚未配置智能体', '前往「智能体」页面添加第一个 ACP 或 A2A 智能体。')) +
    '</div>'
  byId('refresh-overview').onclick = () => refreshReadiness(true)
}

/* ── Runs ─────────────────────────────────────────────────────────── */

function runSummary(label, value) {
  return '<div class="stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
}

function runStatus(value) {
  const style = value === 'completed' ? ' completed' : value === 'failed' ? ' failed' : value === 'running' ? ' running' : (value === 'input_required' || value === 'permission_required') ? ' waiting' : ' canceled'
  return '<span class="status' + style + '">' + escapeHtml(runStatusLabel(value)) + '</span>'
}

function runCard(run) {
  const waiting = run.state === 'input_required' || run.state === 'permission_required'
  return '<article class="run-card' + (waiting ? ' waiting' : '') + '" data-run-detail="' + escapeHtml(run.id) + '" tabindex="0"><div class="run-card-head"><div class="run-card-agent"><span class="badge">' + escapeHtml(run.protocol.toUpperCase()) + '</span><strong>' + escapeHtml(run.agentName) + '</strong></div>' + runStatus(run.state) + '</div><div class="run-task">' + escapeHtml(run.task) + '</div><div class="run-progress"><strong>' + escapeHtml(run.progress && run.progress.phase || '运行中') + '</strong><small>' + escapeHtml(run.progress && run.progress.message || '等待最新进度') + '</small></div><div class="run-meta"><span>' + escapeHtml(shortId(run.id)) + '</span><span>' + escapeHtml(formatDuration(run)) + '</span></div></article>'
}

function runRow(run) {
  return '<tr data-run-detail="' + escapeHtml(run.id) + '"><td><div class="agent-name"><strong>' + escapeHtml(run.agentName) + '</strong><small>' + escapeHtml(run.protocol.toUpperCase()) + '</small></div></td><td class="run-task-cell"><strong>' + escapeHtml(run.task) + '</strong><small class="run-id">' + escapeHtml(shortId(run.id)) + '</small></td><td class="run-task-cell"><strong>' + escapeHtml(run.resultSummary || run.error || '—') + '</strong><small>' + escapeHtml(run.progress && run.progress.phase || '') + '</small></td><td>' + runStatus(run.state) + '</td><td>' + escapeHtml(formatDate(run.startedAt)) + '</td><td>' + escapeHtml(formatDuration(run)) + '</td></tr>'
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
  const completed = state.runs.filter((run) => run.state === 'completed').length
  const failed = state.runs.filter((run) => run.state === 'failed').length
  const agentOptions = state.config.agents.map((agent) => '<option value="' + escapeHtml(agent.id) + '"' + selected(state.runAgent, agent.id) + '>' + escapeHtml(agent.name) + '</option>').join('')
  actions.innerHTML = '<span class="muted">每 5 秒自动刷新</span><button id="refresh-runs" class="button">' + icons.refresh + '立即刷新</button>'
  content.innerHTML =
    '<div class="run-summary">' +
      runSummary('当前运行', state.runs.filter((run) => activeStates.has(run.state)).length) +
      runSummary('已完成', completed) +
      runSummary('失败', failed) +
      runSummary('保留记录', state.runTotal) +
    '</div>' +
    '<div class="toolbar"><div class="search-box">' + icons.search + '<input id="run-search" type="search" placeholder="搜索任务、智能体或运行 ID" value="' + escapeHtml(state.runSearch) + '"></div>' +
    '<select id="run-agent-filter"><option value="all">全部智能体</option>' + agentOptions + '</select>' +
    '<select id="run-status-filter"><option value="all">全部状态</option><option value="running"' + selected(state.runStatus, 'running') + '>运行中</option><option value="input_required"' + selected(state.runStatus, 'input_required') + '>等待输入</option><option value="permission_required"' + selected(state.runStatus, 'permission_required') + '>等待授权</option><option value="completed"' + selected(state.runStatus, 'completed') + '>已完成</option><option value="failed"' + selected(state.runStatus, 'failed') + '>失败</option><option value="canceled"' + selected(state.runStatus, 'canceled') + '>已取消</option></select></div>' +
    '<section class="run-section"><div class="run-section-title"><h2>当前运行</h2><span>' + active.length + ' 项</span></div>' +
      (active.length ? '<div class="run-live-grid">' + active.map(runCard).join('') + '</div>' : '<div class="panel">' + emptyState(icons.activity, '当前没有任务', '没有正在执行或等待处理的任务。') + '</div>') +
    '</section>' +
    '<section class="run-section"><div class="run-section-title"><h2>历史记录</h2><span>' + history.length + ' 项</span></div>' +
      '<div class="table-wrap"><table class="run-table"><thead><tr><th>智能体</th><th>任务</th><th>结果</th><th>状态</th><th>开始时间</th><th>耗时</th></tr></thead><tbody>' +
      (history.length ? history.map(runRow).join('') : '<tr><td colspan="6" class="empty">没有符合条件的历史记录。</td></tr>') +
      '</tbody></table></div></section>'
  byId('refresh-runs').onclick = () => refreshRuns(true)
  byId('run-search').oninput = (event) => { state.runSearch = event.target.value; renderRuns() }
  byId('run-agent-filter').onchange = (event) => { state.runAgent = event.target.value; renderRuns() }
  byId('run-status-filter').onchange = (event) => { state.runStatus = event.target.value; renderRuns() }
}

function detailItem(label, value) {
  return '<div class="run-detail-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
}

export async function openRunDrawer(id) {
  const run = await api('/v1/admin/runs/' + encodeURIComponent(id))
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
  openDrawer('运行详情 · ' + run.agentName, body, '', null)
}

/* ── Agents ───────────────────────────────────────────────────────── */

function agentRow(agent, live) {
  const statusAgent = live || { ready: false, enabled: agent.enabled, checking: true }
  return '<tr><td><div class="agent-name"><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.id) + '</small>' +
    (statusAgent.error && agent.enabled ? '<span class="error-detail">' + escapeHtml(localizeError(statusAgent.error)) + '</span>' : '') +
    '</div></td><td><span class="badge">' + escapeHtml(agent.protocol.toUpperCase()) + '</span></td><td>' + escapeHtml(agent.driver || '—') + '</td><td>' + statusMarkup(statusAgent) + '</td><td>' + escapeHtml(agent.workspace || '—') + '</td><td>' + escapeHtml(permissionLabel(agent.permissionPolicy)) + '</td><td><div class="row-actions"><button class="button small" data-agent-edit="' + escapeHtml(agent.id) + '">编辑</button><button class="button small danger" data-agent-delete="' + escapeHtml(agent.id) + '">删除</button></div></td></tr>'
}

function renderAgents() {
  actions.innerHTML = '<button id="refresh-agents" class="button">' + icons.refresh + '刷新</button><button id="add-agent" class="button primary">' + icons.plus + '添加智能体</button>'
  const readiness = new Map(state.readiness.map((agent) => [agent.id, agent]))
  const rows = state.config.agents.filter((agent) => {
    const live = readiness.get(agent.id) || {}
    const haystack = (agent.name + ' ' + agent.id + ' ' + (agent.description || '')).toLowerCase()
    const status = !readiness.has(agent.id) ? 'checking' : live.ready ? 'ready' : agent.enabled ? 'failed' : 'disabled'
    return haystack.indexOf(state.search.toLowerCase()) >= 0 &&
      (state.protocol === 'all' || agent.protocol === state.protocol) &&
      (state.status === 'all' || status === state.status)
  })
  content.innerHTML =
    '<div class="toolbar"><div class="search-box">' + icons.search + '<input id="agent-search" type="search" placeholder="搜索智能体" value="' + escapeHtml(state.search) + '"></div>' +
    '<select id="protocol-filter"><option value="all">全部协议</option><option value="acp"' + selected(state.protocol, 'acp') + '>ACP</option><option value="a2a"' + selected(state.protocol, 'a2a') + '>A2A</option></select>' +
    '<select id="status-filter"><option value="all">全部状态</option><option value="ready"' + selected(state.status, 'ready') + '>就绪</option><option value="failed"' + selected(state.status, 'failed') + '>不可用</option><option value="disabled"' + selected(state.status, 'disabled') + '>已禁用</option></select></div>' +
    '<div class="table-wrap"><table><thead><tr><th>智能体</th><th>协议</th><th>驱动</th><th>状态</th><th>工作区</th><th>权限策略</th><th></th></tr></thead><tbody>' +
    (rows.length ? rows.map((agent) => agentRow(agent, readiness.get(agent.id))).join('') : '<tr><td colspan="7" class="empty">没有符合条件的智能体。</td></tr>') +
    '</tbody></table></div>'
  byId('agent-search').oninput = (event) => { state.search = event.target.value; renderAgents() }
  byId('protocol-filter').onchange = (event) => { state.protocol = event.target.value; renderAgents() }
  byId('status-filter').onchange = (event) => { state.status = event.target.value; renderAgents() }
  byId('refresh-agents').onclick = () => refreshReadiness(true)
  byId('add-agent').onclick = () => openAgentDrawer()
}

/* ── Workspaces ───────────────────────────────────────────────────── */

function renderWorkspaces() {
  actions.innerHTML = '<button id="add-workspace" class="button primary">' + icons.plus + '添加工作区</button>'
  const roots = state.config.workspaceRoots || []
  content.innerHTML = '<div class="workspace-list">' +
    roots.map((root, index) => '<div class="list-row"><div class="list-row-main"><strong class="path">' + escapeHtml(root) + '</strong><small>ACP 会话允许访问的根目录</small></div><div class="row-actions"><button class="button small" data-workspace-edit="' + index + '">编辑</button><button class="button small danger" data-workspace-delete="' + index + '"' + (roots.length === 1 ? ' disabled' : '') + '>删除</button></div></div>').join('') +
    '</div><div class="tip">建议仅添加必要的最小目录范围。启动 ACP 会话前，Agent Nexus 会解析并校验真实路径。</div>'
  byId('add-workspace').onclick = () => openWorkspaceDrawer()
}

/* ── API keys ─────────────────────────────────────────────────────── */

function keyRow(key) {
  const scope = key.scope.allAgents ? '全部智能体' : (key.scope.agentIds.length ? key.scope.agentIds.join(', ') : '未授权智能体')
  const name = key.legacy && key.name === 'Legacy Access Key' ? '旧版访问密钥' : key.name
  const id = escapeHtml(key.id)
  const toggleLabel = key.enabled ? '禁用密钥' : '启用密钥'
  return '<tr><td><div class="agent-name"><strong>' + escapeHtml(name) + '</strong><small>' + (key.legacy ? '从旧版配置迁移' : '创建于 ' + formatDate(key.createdAt)) + '</small></div></td>' +
    '<td>' + (key.enabled ? '<span class="status ready">已启用</span>' : '<span class="status">已禁用</span>') + '</td>' +
    '<td><div class="key-secret-cell"><code>••••' + escapeHtml(key.suffix) + '</code><button class="key-copy-button" data-key-action="copy" data-key-id="' + id + '" aria-label="复制完整密钥" title="复制完整密钥">' + icons.copy + '</button></div></td>' +
    '<td><span class="key-scope">' + escapeHtml(scope) + '</span></td>' +
    '<td><span class="key-last-used">' + escapeHtml(key.lastUsedAt ? formatDate(key.lastUsedAt) : '从未使用') + '</span></td>' +
    '<td><div class="key-actions"><button class="key-icon-button' + (key.enabled ? ' danger-action' : '') + '" data-key-action="toggle" data-key-id="' + id + '" aria-label="' + toggleLabel + '" title="' + toggleLabel + '">' + (key.enabled ? icons.disable : icons.enable) + '</button><button class="key-icon-button" data-key-action="rename" data-key-id="' + id + '" aria-label="重命名" title="重命名">' + icons.edit + '</button><button class="key-icon-button" data-key-menu="' + id + '" aria-label="更多操作" title="更多操作" aria-expanded="false">' + icons.more + '</button></div></td></tr>'
}

function renderApiKeys() {
  closeKeyActionMenu()
  actions.innerHTML = '<button id="create-key" class="button primary">' + icons.plus + '创建 API 密钥</button>'
  content.innerHTML = state.apiKeys.length
    ? '<div class="table-wrap"><table class="key-table"><thead><tr><th>名称</th><th>状态</th><th>API 密钥</th><th>授权范围</th><th>最后使用</th><th>操作</th></tr></thead><tbody>' + state.apiKeys.map(keyRow).join('') + '</tbody></table></div>'
    : '<div class="panel">' + emptyState(icons.key, '尚未创建 API 密钥', '客户端需要访问网关数据接口时再创建即可。') + '</div>'
  byId('create-key').onclick = () => openKeyDrawer()
}

function emptyState(icon, title, text) {
  return '<div class="empty-state">' + icon + '<strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(text) + '</span></div>'
}

/* ── Settings ─────────────────────────────────────────────────────── */

function renderSettings() {
  const sessionTtlHours = Math.round((state.config.sessionTtlMs || 24 * 60 * 60 * 1000) / 3_600_000)
  const promptTimeoutMinutes = Math.round((state.config.promptTimeoutMs || 30 * 60 * 1000) / 60_000)
  const cleanupIntervalSeconds = Math.round((state.config.cleanupIntervalMs || 60_000) / 1000)
  actions.innerHTML = '<span class="muted">修改后立即生效，新任务按新参数执行</span>'
  content.innerHTML =
    '<div class="settings-layout"><section class="panel settings-form"><div class="panel-header"><div><h2>运行生命周期</h2><p class="settings-subtitle">这些参数由网关统一管理，重启后仍会保留。</p></div></div>' +
    '<div class="settings-fields">' +
    '<div class="field"><label for="session-ttl-hours">Session 空闲有效期（小时）</label><input id="session-ttl-hours" type="number" min="1" max="720" step="1" value="' + escapeHtml(sessionTtlHours) + '"><small class="field-help">Session 在没有新消息、授权或输入交互后，超过此时间会被释放。默认 24 小时。</small></div>' +
    '<div class="field"><label for="prompt-timeout-minutes">单次 ACP 任务超时（分钟）</label><input id="prompt-timeout-minutes" type="number" min="1" max="1440" step="1" value="' + escapeHtml(promptTimeoutMinutes) + '"><small class="field-help">单次 ACP prompt 的最长运行时间。默认 30 分钟；超时后任务会记录为失败并释放运行资源。</small></div>' +
    '<div class="field"><label for="cleanup-interval-seconds">清理任务周期（秒）</label><input id="cleanup-interval-seconds" type="number" min="5" max="3600" step="1" value="' + escapeHtml(cleanupIntervalSeconds) + '"><small class="field-help">网关扫描空闲 Session、过期运行记录和临时输入文件的间隔。默认每 60 秒执行一次。</small></div>' +
    '</div><div class="settings-divider"></div><div class="settings-note"><strong>A2A 请求超时</strong><span>在“智能体 → 编辑 → A2A → 请求超时”中单独配置。默认 60 秒，最大 30 分钟，不受 ACP 全局任务超时字段覆盖。</span></div><div class="settings-actions"><button id="save-runtime-settings" class="button primary">保存运行设置</button></div></section></div>'
  byId('save-runtime-settings').onclick = async () => {
    const values = {
      sessionTtlMs: Number(byId('session-ttl-hours').value) * 3_600_000,
      promptTimeoutMs: Number(byId('prompt-timeout-minutes').value) * 60_000,
      cleanupIntervalMs: Number(byId('cleanup-interval-seconds').value) * 1000
    }
    if (!Object.values(values).every((value) => Number.isInteger(value) && value > 0)) {
      toast('请输入有效的整数运行参数。', true)
      return
    }
    await runAction(async () => {
      state.config = await api('/v1/admin/config/runtime', { method: 'PUT', body: values })
      render()
      toast('运行设置已保存并立即生效')
    })
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
    '<div class="field-row"><div class="field"><label for="f-protocol">协议</label><select id="f-protocol" name="protocol"><option value="acp"' + selected(current.protocol, 'acp') + '>ACP</option><option value="a2a"' + selected(current.protocol, 'a2a') + '>A2A</option></select></div><div class="field"><label>&nbsp;</label><label class="checkbox"><input name="enabled" type="checkbox"' + checked(current.enabled) + '>启用</label></div></div>' +
    '<div class="field"><label for="f-name">名称</label><input id="f-name" name="name" value="' + escapeHtml(current.name || '') + '" required></div>' +
    '<div class="field"><label for="f-description">描述</label><textarea id="f-description" name="description">' + escapeHtml(current.description || '') + '</textarea></div>' +
    '<div data-protocol-section="acp"><div class="field"><label for="f-driver">驱动</label><select id="f-driver" name="driver">' + drivers + '</select></div><div class="field"><label for="f-workspace">工作区</label><input id="f-workspace" name="workspace" list="workspace-roots" value="' + escapeHtml(current.workspace || state.config.workspaceRoots[0] || '') + '" required><datalist id="workspace-roots">' + roots + '</datalist></div><div class="field-row"><div class="field"><label for="f-permissionPolicy">权限策略</label><select id="f-permissionPolicy" name="permissionPolicy"><option value="ask"' + selected(current.permissionPolicy, 'ask') + '>询问</option><option value="allow"' + selected(current.permissionPolicy, 'allow') + '>始终允许</option><option value="deny"' + selected(current.permissionPolicy, 'deny') + '>拒绝</option></select></div><div class="field"><label for="f-permissionTimeoutMs">权限确认超时（秒）</label><input id="f-permissionTimeoutMs" name="permissionTimeoutMs" type="number" min="1" max="86400" step="1" value="' + escapeHtml(permissionTimeoutSeconds) + '"><small class="field-help">默认 900 秒，最长 24 小时；“始终允许”不会等待确认。</small></div></div></div>' +
    '<div data-protocol-section="a2a"><div class="field"><label for="f-agentCardUrl">Agent Card URL</label><input id="f-agentCardUrl" name="agentCardUrl" type="url" value="' + escapeHtml(current.agentCardUrl || '') + '" placeholder="http://agent.local:8080/.well-known/agent-card.json" required><small class="field-help">填写完整的 Agent Card JSON 地址；调用地址和能力将从 Card 自动发现。</small></div><div class="field-row"><div class="field"><label for="f-preferredTransport">首选传输</label><select id="f-preferredTransport" name="preferredTransport"><option value="auto"' + selected(current.preferredTransport || 'auto', 'auto') + '>自动（按 Card）</option><option value="jsonrpc"' + selected(current.preferredTransport, 'jsonrpc') + '>JSON-RPC</option><option value="http-json"' + selected(current.preferredTransport, 'http-json') + '>HTTP+JSON</option></select></div><div class="field"><label for="f-authType">认证方式</label><select id="f-authType" name="authType"><option value="none"' + selected(current.auth && current.auth.type || 'none', 'none') + '>无认证</option><option value="bearer"' + selected(current.auth && current.auth.type, 'bearer') + '>Bearer Token</option><option value="header"' + selected(current.auth && current.auth.type, 'header') + '>自定义请求头</option></select></div></div><div class="field" data-auth-header><label for="f-authHeaderName">请求头名称</label><input id="f-authHeaderName" name="authHeaderName" value="' + escapeHtml(current.auth && current.auth.headerName || '') + '" placeholder="X-API-Key"></div><div class="field" data-auth-value><label data-auth-value-label for="f-authValue">认证凭据</label><input id="f-authValue" name="authValue" type="password" autocomplete="off" placeholder="' + (editing && current.auth && current.auth.configured ? '留空以保留当前凭据' : '') + '"></div><div class="field"><label for="f-timeoutMs">请求超时（秒）</label><input id="f-timeoutMs" name="timeoutMs" type="number" min="1" max="1800" step="1" value="' + escapeHtml(requestTimeoutSeconds) + '"><small class="field-help">默认 60 秒；限制这个 A2A Agent 的单次请求，最大 1800 秒（30 分钟）。</small></div></div>'
  openDrawer(editing ? '编辑智能体' : '添加智能体', body, editing ? '保存修改' : '添加智能体', async (form) => {
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
    closeDrawer()
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
  openDrawer(editing ? '编辑工作区' : '添加工作区', '<div class="field"><label for="f-path">允许访问的根目录</label><input id="f-path" name="path" value="' + escapeHtml(current) + '" required></div>', editing ? '保存修改' : '添加工作区', async (form) => {
    const roots = state.config.workspaceRoots.slice()
    const value = String(new FormData(form).get('path') || '').trim()
    if (editing) roots[index] = value
    else roots.push(value)
    const result = await api('/v1/admin/config/workspace-roots', { method: 'PUT', body: { workspaceRoots: roots } })
    state.config = result
    closeDrawer()
    render()
    toast(editing ? '工作区已更新' : '工作区已添加')
  })
}

export function openKeyDrawer() {
  const scopeRows = state.config.agents.map((agent) => '<label class="checkbox"><input type="checkbox" name="agentId" value="' + escapeHtml(agent.id) + '">' + escapeHtml(agent.name) + ' <span class="muted">(' + escapeHtml(agent.protocol.toUpperCase()) + ')</span></label>').join('')
  const body = '<div class="field"><label for="f-name">名称</label><input id="f-name" name="name" required autocomplete="off" placeholder="例如：开发客户端"></div><div class="field"><label class="checkbox"><input id="all-agents" name="allAgents" type="checkbox" checked>允许访问全部智能体</label></div><div id="agent-scope" class="agent-scope hidden">' + (scopeRows || '<span class="muted">尚未配置智能体。</span>') + '</div><div class="field"><label for="f-customSecret">自定义密钥（可选）</label><input id="f-customSecret" name="customSecret" minlength="16" autocomplete="off" placeholder="留空则自动生成 nx_sk_ 密钥"></div>'
  openDrawer('创建 API 密钥', body, '创建 API 密钥', async (form) => {
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
    showSecret('API 密钥已创建', result.secret)
    render()
  })
  const all = byId('all-agents')
  all.onchange = () => byId('agent-scope').classList.toggle('hidden', all.checked)
}

export function showSecret(title, secret) {
  openDrawer(title, '<div class="secret-box"><span class="muted">请立即复制此密钥；之后也可在 API 密钥页面再次显示。</span><code class="secret-value">' + escapeHtml(secret) + '</code><button class="button" type="button" id="copy-secret">' + icons.copy + '复制</button></div>', '', null)
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
  document.body.appendChild(temporary)
  temporary.select()
  const copied = document.execCommand('copy')
  temporary.remove()
  if (!copied) throw new Error('无法自动复制，请在“显示完整密钥”中手动复制。')
}

export function openPasswordDrawer() {
  openDrawer('修改控制台密码', '<div class="field"><label for="f-currentPassword">当前密码</label><input id="f-currentPassword" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="f-newPassword">新密码</label><input id="f-newPassword" name="newPassword" type="password" minlength="12" autocomplete="new-password" required></div><div class="field"><label for="f-confirmPassword">确认新密码</label><input id="f-confirmPassword" name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required></div>', '修改密码', async (form) => {
    const data = new FormData(form)
    await api('/v1/admin/password', { method: 'PUT', body: { currentPassword: String(data.get('currentPassword') || ''), newPassword: String(data.get('newPassword') || ''), confirmPassword: String(data.get('confirmPassword') || '') } })
    closeDrawer()
    showLogin()
    toast('控制台密码已修改，请重新登录。')
  })
}

export function openKeyScopeDrawer(key) {
  const selectedIds = new Set(key.scope.agentIds || [])
  const scopeRows = state.config.agents.map((agent) => '<label class="checkbox"><input type="checkbox" name="agentId" value="' + escapeHtml(agent.id) + '"' + checked(selectedIds.has(agent.id)) + '>' + escapeHtml(agent.name) + ' <span class="muted">(' + escapeHtml(agent.protocol.toUpperCase()) + ')</span></label>').join('')
  const body = '<div class="field"><label class="checkbox"><input id="edit-all-agents" name="allAgents" type="checkbox"' + checked(key.scope.allAgents) + '>允许访问全部智能体</label></div><div id="edit-agent-scope" class="agent-scope' + (key.scope.allAgents ? ' hidden' : '') + '">' + (scopeRows || '<span class="muted">尚未配置智能体。</span>') + '</div>'
  openDrawer('编辑 API 密钥授权范围', body, '保存授权范围', async (form) => {
    const data = new FormData(form)
    const allAgents = data.get('allAgents') === 'on'
    const agentIds = data.getAll('agentId').map(String)
    if (!allAgents && !agentIds.length) throw new Error('请至少选择一个智能体')
    await api('/v1/admin/api-keys/' + encodeURIComponent(key.id), { method: 'PATCH', body: { scope: { allAgents, agentIds } } })
    closeDrawer()
    await reloadKeys()
    toast('API 密钥授权范围已更新')
  })
  const all = byId('edit-all-agents')
  all.onchange = () => byId('edit-agent-scope').classList.toggle('hidden', all.checked)
}

export async function reloadKeys() {
  const value = await api('/v1/admin/api-keys')
  state.apiKeys = value.apiKeys || []
  render()
}

/* ── Key action menu ──────────────────────────────────────────────── */

export function toggleKeyActionMenu(anchor, id) {
  if (!keyActionMenu.classList.contains('hidden') && keyActionMenu.dataset.keyId === id) {
    closeKeyActionMenu()
    return
  }
  closeKeyActionMenu()
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
}

export function closeKeyActionMenu() {
  keyActionMenu.classList.add('hidden')
  keyActionMenu.innerHTML = ''
  keyActionMenu.dataset.keyId = ''
  document.querySelectorAll('[data-key-menu][aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'))
}

