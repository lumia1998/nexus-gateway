import { state } from './state.js'
import { byId, drawerForm, escapeHtml, selected, checked } from './dom.js'
import { icons } from './icons.js'
import { api, localizeError } from './api.js'
import { toast, withBusy } from './toast.js'
import { openDrawer, closeDrawer, getDrawerVersion } from './drawer.js'
import { copySecret } from './render-keys.js'

import { loadAll, refreshReadiness } from './data.js'
import { permissionLabel } from './format.js'

import { render } from './render.js'
import { setResults, setActions, setToolbar, announce, emptyState, bindSearch, preciseUnitValue } from './render-shared.js'

export function statusMarkup(agent) {
  if (!agent.enabled) return '<span class="status">已禁用</span>'
  if (agent.checking) return '<span class="status checking">检查中</span>'
  return agent.ready ? '<span class="status ready" title="' + (agent.protocol === 'acp' ? '命令探测通过；创建会话时才进行 ACP 握手' : 'Agent Card 探测通过；实际任务可能仍失败') + '">' + (agent.protocol === 'acp' ? '命令可用' : 'Card 可用') + '</span>' : '<span class="status failed">不可用</span>'
}

export function readinessById() {
  return new Map(state.readiness.map((agent) => [agent.id, agent]))
}

export function agentReadiness(agent, lookup) {
  return { ...(lookup.get(agent.id) || { ready: false, checking: true }),
    id: agent.id,
    name: agent.name,
    protocol: agent.protocol,
    driver: agent.driver,
    enabled: agent.enabled
  }
}

export function readinessRows() {
  const lookup = readinessById()
  return state.config.agents.map((agent) => agentReadiness(agent, lookup))
}

export function agentRow(agent, live) {
  const statusAgent = { ...(live || { ready: false, checking: true }), enabled: agent.enabled }
  return '<tr><td><div class="agent-name"><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.id) + '</small>' +
    (statusAgent.error && agent.enabled ? '<span class="error-detail">' + escapeHtml(localizeError(statusAgent.error)) + '</span>' : '') +
    '</div></td><td><span class="badge">' + escapeHtml(agent.protocol.toUpperCase()) + '</span></td><td>' + escapeHtml(agent.driver || '—') + '</td><td>' + statusMarkup(statusAgent) + '</td><td>' + escapeHtml(agent.workspace || '—') + '</td><td>' + escapeHtml(permissionLabel(agent.permissionPolicy)) + '</td><td><div class="row-actions"><button class="button small" data-agent-edit="' + escapeHtml(agent.id) + '">编辑</button><button class="button small" data-agent-diagnostics="' + escapeHtml(agent.id) + '"' + (agent.enabled ? '' : ' disabled') + '>诊断</button><button class="button small danger" data-agent-delete="' + escapeHtml(agent.id) + '">删除</button></div></td></tr>'
}

export function renderAgents() {
  setActions('<button id="stdio-guide" class="button">接入自定义 ACP</button><button id="refresh-agents" class="button">' + icons.refresh + '刷新</button><button id="add-agent" class="button primary">' + icons.plus + '添加智能体</button>')
  byId('stdio-guide').onclick = openStdioGuide
  byId('refresh-agents').onclick = (event) => withBusy(event.currentTarget, () => refreshReadiness(true))
  byId('add-agent').onclick = () => openAgentDrawer()
  byId('add-agent').disabled = !state.resources.config.lastSuccessAt

  if (!state.config.agents.length && ['idle', 'loading'].includes(state.resources.config.status)) {
    setToolbar('')
    setResults('<div class="panel"><p class="panel-note">正在加载智能体配置…</p></div>')
    announce('正在加载智能体配置')
    return
  }
  if (!state.resources.config.lastSuccessAt) {
    setToolbar('')
    setResults('<div class="panel"><p class="panel-note">智能体配置读取失败，请重试后编辑。</p></div>')
    return
  }
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
    const status = !agent.enabled ? 'disabled' : !lookup.has(agent.id) ? 'checking' : live.ready ? 'ready' : 'failed'
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

export function openAgentDrawer(agent) {
  if (!state.resources.config.lastSuccessAt) { toast('配置尚未成功读取，请重试后编辑', true); return }
  const editing = Boolean(agent)
  const current = agent || { protocol: 'acp', enabled: true, permissionPolicy: 'ask', permissionTimeoutMs: 900000, timeoutMs: 60000 }
  const permissionTimeoutSeconds = preciseUnitValue(current.permissionTimeoutMs, 1000, 900000)
  const requestTimeoutSeconds = preciseUnitValue(current.timeoutMs, 1000, 60000)
  const inheritedTaskTimeoutMs = Number(state.config.promptTimeoutMs || 30 * 60 * 1000)
  const inheritedIdleTimeoutMs = Number(current.timeoutMs || 60 * 1000)
  const taskTimeoutSeconds = current.taskTimeoutMs === undefined ? '' : preciseUnitValue(current.taskTimeoutMs, 1000, 30 * 60)
  const streamIdleTimeoutSeconds = current.streamIdleTimeoutMs === undefined ? '' : preciseUnitValue(current.streamIdleTimeoutMs, 1000, 60)
  const taskTimeoutInherited = current.taskTimeoutMs === undefined
  const streamIdleTimeoutInherited = current.streamIdleTimeoutMs === undefined
  const configuredDriver = current.driver || state.config.driverKinds[0]
  const driverKinds = [...new Set([...(state.config.driverKinds || []), ...(editing && current.driver ? [current.driver] : [])])]
  const visibleDriverKinds = editing && current.driver === 'stdio' ? driverKinds : driverKinds.filter((driver) => driver !== 'stdio')
  const drivers = visibleDriverKinds.map((driver) => '<option value="' + escapeHtml(driver) + '"' + selected(configuredDriver, driver) + '>' + escapeHtml(driver) + '</option>').join('')
  const roots = state.config.workspaceRoots.map((root) => '<option value="' + escapeHtml(root) + '"></option>').join('')
  const stdioNotice = '<div data-driver-section="stdio" class="field' + (configuredDriver === 'stdio' ? '' : ' hidden') + '"><small class="field-help">stdio 的 command、参数与环境变量由本地配置提供；控制台仅支持编辑已有项的通用设置。</small></div>'
  const body =
    '<div class="field"><label for="f-id">智能体 ID</label><input id="f-id" name="id" value="' + escapeHtml(current.id || '') + '" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" required' + (editing ? ' disabled' : '') + '></div>' +
    '<div class="field-row"><div class="field"><label for="f-protocol">协议</label><select id="f-protocol" name="protocol"><option value="acp"' + selected(current.protocol, 'acp') + '>ACP</option><option value="a2a"' + selected(current.protocol, 'a2a') + '>A2A</option></select></div><div class="field"><span class="field-spacer" aria-hidden="true">&nbsp;</span><label class="checkbox"><input name="enabled" type="checkbox"' + checked(current.enabled) + '>启用</label></div></div>' +
    '<div class="field"><label for="f-name">名称</label><input id="f-name" name="name" value="' + escapeHtml(current.name || '') + '" required></div>' +
    '<div class="field"><label for="f-description">描述</label><textarea id="f-description" name="description">' + escapeHtml(current.description || '') + '</textarea></div>' +
    '<div data-protocol-section="acp"><div class="field"><label for="f-driver">驱动</label><select id="f-driver" name="driver">' + (drivers || '<option value="" disabled selected>请先配置可用驱动</option>') + '</select></div>' + stdioNotice + '<div class="field"><label for="f-workspace">工作区</label><input id="f-workspace" name="workspace" list="workspace-roots" value="' + escapeHtml(current.workspace || state.config.workspaceRoots[0] || '') + '" required><datalist id="workspace-roots">' + roots + '</datalist></div><div class="field-row"><div class="field"><label for="f-permissionPolicy">权限策略</label><select id="f-permissionPolicy" name="permissionPolicy"><option value="ask"' + selected(current.permissionPolicy, 'ask') + '>询问</option><option value="allow"' + selected(current.permissionPolicy, 'allow') + '>自动允许单次</option><option value="deny"' + selected(current.permissionPolicy, 'deny') + '>拒绝</option></select></div><div class="field"><label for="f-permissionTimeoutMs">权限确认超时（秒）</label><input id="f-permissionTimeoutMs" name="permissionTimeoutMs" type="number" min="1" max="86400" step="0.001" value="' + escapeHtml(permissionTimeoutSeconds) + '"><small class="field-help">默认 900 秒，最长 24 小时。自动策略只选 allow_once；只有永久选项时拒绝，请改为询问并显式授权。</small></div></div></div>' +
    '<div data-protocol-section="a2a"><div class="field"><label for="f-agentCardUrl">Agent Card URL</label><input id="f-agentCardUrl" name="agentCardUrl" type="url" value="' + escapeHtml(current.agentCardUrl || '') + '" placeholder="http://agent.local:8080/.well-known/agent-card.json" required><small class="field-help">调用地址与能力从 Card 自动发现。</small></div><div class="field-row"><div class="field"><label for="f-preferredTransport">首选传输</label><select id="f-preferredTransport" name="preferredTransport"><option value="auto"' + selected(current.preferredTransport || 'auto', 'auto') + '>自动（按 Card）</option><option value="jsonrpc"' + selected(current.preferredTransport, 'jsonrpc') + '>JSON-RPC</option><option value="http-json"' + selected(current.preferredTransport, 'http-json') + '>HTTP+JSON</option></select></div><div class="field"><label for="f-authType">认证方式</label><select id="f-authType" name="authType"><option value="none"' + selected(current.auth && current.auth.type || 'none', 'none') + '>无认证</option><option value="bearer"' + selected(current.auth && current.auth.type, 'bearer') + '>Bearer Token</option><option value="header"' + selected(current.auth && current.auth.type, 'header') + '>自定义请求头</option></select></div></div><div class="field" data-auth-header><label for="f-authHeaderName">请求头名称</label><input id="f-authHeaderName" name="authHeaderName" value="' + escapeHtml(current.auth && current.auth.headerName || '') + '" placeholder="X-API-Key"></div><div class="field" data-auth-value><label data-auth-value-label for="f-authValue">认证凭据</label><input id="f-authValue" name="authValue" type="password" autocomplete="off" placeholder="' + (editing && current.auth && current.auth.configured ? '留空以保留当前凭据' : '') + '"></div><div class="field"><label for="f-timeoutMs">普通请求/建连超时（秒）</label><input id="f-timeoutMs" name="timeoutMs" type="number" min="1" max="1800" step="any" value="' + escapeHtml(requestTimeoutSeconds) + '"><small class="field-help">只限制单次请求和建连，不限制整轮任务。</small></div><div class="field"><label for="f-taskTimeoutMs">单轮任务期限（秒）</label><input id="f-taskTimeoutMs" name="taskTimeoutMs" type="number" min="10" max="86400" step="any" value="' + escapeHtml(taskTimeoutSeconds) + '" placeholder="继承全局 ACP 任务超时（' + escapeHtml(preciseUnitValue(inheritedTaskTimeoutMs, 1000, 1800)) + ' 秒）" data-inherited="' + (taskTimeoutInherited ? 'true' : 'false') + '"><small class="field-help">留空表示继承全局 ACP 任务超时（当前 ' + escapeHtml(preciseUnitValue(inheritedTaskTimeoutMs, 1000, 1800)) + ' 秒）。</small></div><div class="field"><label for="f-streamIdleTimeoutMs">流无进度超时（秒）</label><input id="f-streamIdleTimeoutMs" name="streamIdleTimeoutMs" type="number" min="1" max="1800" step="any" value="' + escapeHtml(streamIdleTimeoutSeconds) + '" placeholder="继承普通请求/建连超时（' + escapeHtml(preciseUnitValue(inheritedIdleTimeoutMs, 1000, 60)) + ' 秒）" data-inherited="' + (streamIdleTimeoutInherited ? 'true' : 'false') + '"><small class="field-help">留空表示继承普通请求/建连超时，收到进度会重新计时。</small></div></div>'
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
      payload.permissionTimeoutMs = Math.round(Number(data.get('permissionTimeoutMs')) * 1000)
    } else {
      payload.agentCardUrl = String(data.get('agentCardUrl') || '').trim()
      payload.preferredTransport = data.get('preferredTransport')
      payload.authType = data.get('authType')
      payload.authHeaderName = String(data.get('authHeaderName') || '').trim()
      const authValue = String(data.get('authValue') || '')
      if (authValue) payload.authValue = authValue
      payload.timeoutMs = Math.round(Number(data.get('timeoutMs')) * 1000)
      const taskTimeoutInput = drawerFormElements().taskTimeoutMs
      const taskTimeoutValue = String(data.get('taskTimeoutMs') || '').trim()
      payload.taskTimeoutMs = taskTimeoutValue ? Math.round(Number(taskTimeoutValue) * 1000) : null
      if (!taskTimeoutValue && taskTimeoutInput.dataset.inherited === 'true' && current.taskTimeoutMs === undefined) delete payload.taskTimeoutMs
      const streamIdleInput = drawerFormElements().streamIdleTimeoutMs
      const streamIdleValue = String(data.get('streamIdleTimeoutMs') || '').trim()
      payload.streamIdleTimeoutMs = streamIdleValue ? Math.round(Number(streamIdleValue) * 1000) : null
      if (!streamIdleValue && streamIdleInput.dataset.inherited === 'true' && current.streamIdleTimeoutMs === undefined) delete payload.streamIdleTimeoutMs
    }
    await api('/v1/admin/agents/' + encodeURIComponent(id), { method: 'PUT', body: payload })
    if (isCurrent()) closeDrawer()
    render()
    toast(editing ? '智能体已更新' : '智能体已添加')
    void loadAll(true)
  })
  const protocolSelect = drawerFormElements().protocol
  const authSelect = drawerFormElements().authType
  const sync = () => {
    document.querySelectorAll('#drawer-form [data-protocol-section]').forEach((section) => {
      section.classList.toggle('hidden', section.dataset.protocolSection !== protocolSelect.value)
      section.querySelectorAll('input,select,textarea').forEach((field) => { field.disabled = section.classList.contains('hidden') })
    })
    const driver = drawerFormElements().driver?.value
    document.querySelectorAll('#drawer-form [data-driver-section]').forEach((section) => {
      const hidden = protocolSelect.value !== 'acp' || section.dataset.driverSection !== driver
      section.classList.toggle('hidden', hidden)
      section.querySelectorAll('input,textarea').forEach((field) => { field.disabled = hidden })
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
  byId('f-driver').onchange = sync
  byId('f-taskTimeoutMs').oninput = (event) => { event.currentTarget.dataset.inherited = 'false' }
  byId('f-streamIdleTimeoutMs').oninput = (event) => { event.currentTarget.dataset.inherited = 'false' }
  sync()
}

export function drawerFormElements() {
  return byId('drawer-form').elements
}

export async function openAgentDiagnostics(id) {
  openDrawer('智能体连接诊断', '<p role="status">正在启动智能体并验证连接，完成后释放诊断会话；不会发送任务。</p>', '', null)
  const version = getDrawerVersion()
  try {
    const result = await api('/v1/admin/agents/' + encodeURIComponent(id) + '/diagnostics', { method: 'POST', body: {} })
    if (version !== getDrawerVersion()) return
    drawerForm.innerHTML = '<p>' + escapeHtml(result.ok ? '连接诊断通过' : '连接诊断未通过') + '</p><div class="overview-list">' +
      (result.stages || []).map((stage) => '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(({ validate: '配置检查', start: '启动连接', initialize: '协议握手', createSession: '建立会话', connect: '连接与会话建立', handshake: '连接与会话建立', close: '清理会话' })[stage.name || stage.stage] || stage.name || stage.stage || '检查') + '</strong><small>' + escapeHtml(stage.message || stage.error || '') + '</small></div><span>' + escapeHtml(({ passed: '通过', failed: '失败', skipped: '跳过' })[stage.status] || stage.status || '') + '</span></div>').join('') +
      '</div><p class="field-help">' + escapeHtml(result.message || '') + '</p>'
  } catch (error) {
    if (version === getDrawerVersion()) drawerForm.innerHTML = '<p class="form-error" role="alert">' + escapeHtml(error.message) + '</p>'
  }
}

export function openStdioGuide() {
  const sample = JSON.stringify({ custom: { protocol: 'acp', driver: 'stdio', name: '自定义 ACP', command: '/absolute/path/to/your-agent', args: ['--acp'], probeArgs: ['--version'], workspace: state.config.workspaceRoots[0] || '/path/to/workspace', permissionPolicy: 'ask' } }, null, 2)
  openDrawer('接入自定义 ACP', '<p class="field-help">将下方智能体项合并到本地配置的 agents 中，并按实际命令调整参数。重启网关后可在列表中执行连接诊断。command、args、probeArgs、inheritEnv 和 env 由本地配置管理。</p><pre class="run-detail-code">' + escapeHtml(sample) + '</pre><button class="button" type="button" id="copy-stdio-config">复制配置示例</button>', '', null)
  byId('copy-stdio-config').onclick = async () => {
    try { await copySecret(sample); toast('配置示例已复制') } catch (error) { toast(error.message, true) }
  }
}
