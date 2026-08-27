export const app = String.raw`
(() => {
  'use strict'

  const state = {
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

  const pageMeta = {
    overview: ['总览', '查看已配置智能体运行时的实时状态。'],
    runs: ['运行记录', '追踪当前任务进度，并查看已完成或失败的历史任务。'],
    agents: ['智能体', '配置本地 ACP 进程和远程 A2A 智能体。'],
    workspaces: ['工作区', '管理 ACP 智能体允许访问的路径。'],
    keys: ['API 密钥', '管理 Agent Nexus 数据接口的客户端凭据。'],
    settings: ['运行设置', '调整会话生命周期、任务超时和后台清理周期。']
  }

  const actionIcons = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"></rect><path d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"></path></svg>',
    disable: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="m6.3 6.3 11.4 11.4"></path></svg>',
    enable: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="m8.5 12 2.3 2.3 4.8-5"></path></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h8"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>',
    reveal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>',
    scope: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.7 2.9 8 7 10 4.1-2 7-5.3 7-10V6Z"></path><path d="M9.5 12 11 13.5l3.5-4"></path></svg>',
    regenerate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5"></path><path d="M19 12a7 7 0 1 0-2 5"></path></svg>',
    delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="m6 7 1 13h10l1-13"></path><path d="M10 11v5M14 11v5"></path></svg>'
  }

  const byId = (id) => document.getElementById(id)
  const setupScreen = byId('setup-screen')
  const loginScreen = byId('login-screen')
  const appRoot = byId('app')
  const content = byId('page-content')
  const actions = byId('page-actions')
  const drawer = byId('drawer')
  const drawerBackdrop = byId('drawer-backdrop')
  const drawerForm = byId('drawer-form')
  const keyActionMenu = document.createElement('div')
  keyActionMenu.className = 'key-action-menu hidden'
  keyActionMenu.setAttribute('role', 'menu')
  document.body.appendChild(keyActionMenu)
  let drawerSubmit = null

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
  }

  function selected(value, expected) {
    return value === expected ? ' selected' : ''
  }

  function checked(value) {
    return value ? ' checked' : ''
  }

  async function api(path, options) {
    const settings = Object.assign({ credentials: 'same-origin' }, options || {})
    settings.headers = Object.assign({}, settings.headers || {})
    if (settings.body && typeof settings.body !== 'string') {
      settings.headers['Content-Type'] = 'application/json'
      settings.body = JSON.stringify(settings.body)
    }
    const response = await fetch(path, settings)
    let value = null
    try { value = await response.json() } catch {}
    if (!response.ok) {
      if (response.status === 401 && path.indexOf('/v1/admin/') === 0) showLogin()
      const message = value && value.error ? value.error : '请求失败（HTTP ' + response.status + '）'
      const error = new Error(localizeError(message))
      error.status = response.status
      throw error
    }
    return value
  }

  function localizeError(message) {
    const messages = {
      'Invalid Console Password': '控制台密码不正确',
      'Console setup is required': '请先完成控制台初始化',
      'Console setup is already complete': '控制台已完成初始化',
      'Console Password confirmation does not match': '两次输入的控制台密码不一致',
      'Console Password must contain at least 12 characters': '控制台密码至少需要 12 个字符',
      'Console Password must not exceed 1024 bytes': '控制台密码不能超过 1024 字节',
      'Console Password must not contain NUL bytes': '控制台密码包含不支持的字符',
      'Current Console Password is incorrect': '当前控制台密码不正确',
      'Gateway setup is required': '请先完成网关初始化',
      'Admin session is required': '管理员会话已失效，请重新登录',
      'Bearer API Key is required': '缺少 Bearer API 密钥',
      'Invalid API Key': 'API 密钥无效',
      'API Key is not authorized for this agent': '该 API 密钥无权访问此智能体',
      'API Key already exists': 'API 密钥已存在',
      'API Key not found': '未找到 API 密钥',
      'API Key name is required': '请输入 API 密钥名称',
      'API Key name is too long': 'API 密钥名称过长',
      'Custom API Key must contain at least 16 characters': '自定义 API 密钥至少需要 16 个字符',
      'Custom API Key must not exceed 512 bytes': '自定义 API 密钥不能超过 512 字节',
      'Custom API Key contains an unsupported value': '自定义 API 密钥包含不支持的内容',
      'workspaceRoots must contain at least one path': '至少需要保留一个工作区根目录',
      'A2A authentication value is required': '请输入 A2A 认证凭据',
      'A2A authentication value is invalid': 'A2A 认证凭据无效',
      'A2A Agent Card URL is required': '请输入 Agent Card URL',
      'A2A Agent Card URL is invalid': 'Agent Card URL 无效',
      'A2A Agent Card URL must use http(s) without credentials or a fragment': 'Agent Card URL 必须使用 HTTP(S)，且不能包含凭据或片段',
      'preferredTransport must be auto, jsonrpc, or http-json': '首选传输必须是自动、JSON-RPC 或 HTTP+JSON',
      'A valid A2A header name is required': '请输入有效的 A2A 请求头名称',
      'Too many authentication attempts': '认证失败次数过多，请稍后再试',
      'Request body is too large': '请求内容过大',
      'Request requires application/json': '请求必须使用 application/json',
      'Same-origin request is required': '此操作必须从当前控制台页面发起',
      'Request origin is invalid': '请求来源无效',
      'Cross-origin admin request is not allowed': '不允许跨域管理请求',
      'Control plane is unavailable': '管理控制面当前不可用',
      'Agent Nexus run not found': '未找到运行记录',
      'Internal server error': '服务器内部错误'
    }
    if (messages[message]) return messages[message]
    const missingAgent = /^Configured agent not found: (.+)$/.exec(message)
    if (missingAgent) return '未找到已配置的智能体：' + missingAgent[1]
    const timeout = /^timeout must be between (\d+) and (\d+)$/.exec(message)
    if (timeout) return '超时时间必须介于 ' + timeout[1] + ' 和 ' + timeout[2] + ' 毫秒之间'
    const runtimeRange = /^(sessionTtlMs|promptTimeoutMs|cleanupIntervalMs) must be between (\d+) and (\d+)$/.exec(message)
    if (runtimeRange) {
      const labels = { sessionTtlMs: 'Session 空闲有效期', promptTimeoutMs: 'ACP 任务超时', cleanupIntervalMs: '清理任务周期' }
      return labels[runtimeRange[1]] + '必须介于 ' + runtimeRange[2] + ' 和 ' + runtimeRange[3] + ' 毫秒之间'
    }
    return message
  }

  function showOnly(element) {
    setupScreen.classList.add('hidden')
    loginScreen.classList.add('hidden')
    appRoot.classList.add('hidden')
    element.classList.remove('hidden')
  }

  function showLogin() {
    state.authenticated = false
    showOnly(loginScreen)
    byId('login-form').reset()
  }

  async function boot() {
    applyTheme(localStorage.getItem('agent-nexus-theme') || 'system')
    try {
      const bootstrap = await api('/v1/bootstrap/status')
      if (bootstrap.adminSetupRequired) {
        showOnly(setupScreen)
        return
      }
      const auth = await api('/v1/admin/auth/status')
      if (!auth.authenticated) {
        showLogin()
        return
      }
      await enterApp()
    } catch (error) {
      showLogin()
      toast(error.message, true)
    }
  }

  async function enterApp() {
    state.authenticated = true
    showOnly(appRoot)
    await loadAll()
    render()
  }

  async function loadAll(force) {
    const suffix = force ? '?refresh=1' : ''
    const values = await Promise.all([
      api('/v1/admin/config'),
      api('/v1/admin/api-keys'),
      api('/v1/admin/overview' + suffix),
      api('/v1/admin/runs?limit=200')
    ])
    state.config = values[0]
    state.apiKeys = values[1].apiKeys || []
    state.readiness = values[2].agents || []
    state.sessions = values[2].sessions || 0
    state.runs = values[3].runs || []
    state.runTotal = values[3].total || 0
  }

  async function refreshRuns(showNotice) {
    try {
      const value = await api('/v1/admin/runs?limit=200')
      state.runs = value.runs || []
      state.runTotal = value.total || 0
      if (state.page === 'runs') renderRuns()
      if (showNotice) toast('运行记录已刷新')
    } catch (error) {
      if (showNotice) toast(error.message, true)
    }
  }

  async function refreshReadiness(showNotice) {
    try {
      const overview = await api('/v1/admin/overview?refresh=1')
      state.readiness = overview.agents || []
      state.sessions = overview.sessions || 0
      render()
      if (showNotice) toast('运行状态已刷新')
    } catch (error) {
      if (showNotice) toast(error.message, true)
    }
  }

  function render() {
    const meta = pageMeta[state.page]
    byId('page-title').textContent = meta[0]
    byId('page-description').textContent = meta[1]
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

  function renderSettings() {
    const sessionTtlHours = Math.round((state.config.sessionTtlMs || 24 * 60 * 60 * 1000) / 3_600_000)
    const promptTimeoutMinutes = Math.round((state.config.promptTimeoutMs || 30 * 60 * 1000) / 60_000)
    const cleanupIntervalSeconds = Math.round((state.config.cleanupIntervalMs || 60_000) / 1000)
    actions.innerHTML = '<span class="muted">修改后立即生效，新任务按新参数执行</span>'
    content.innerHTML =
      '<div class="settings-layout"><section class="panel settings-form"><div class="panel-header"><div><h2>运行生命周期</h2><p class="settings-subtitle">这些参数由网关统一管理，重启后仍会保留。</p></div></div>' +
      '<div class="settings-fields">' +
      '<label>Session 空闲有效期（小时）<input id="session-ttl-hours" type="number" min="1" max="720" step="1" value="' + escapeHtml(sessionTtlHours) + '"><small class="field-help">Session 在没有新消息、授权或输入交互后，超过此时间会被释放。默认 24 小时。</small></label>' +
      '<label>单次 ACP 任务超时（分钟）<input id="prompt-timeout-minutes" type="number" min="1" max="1440" step="1" value="' + escapeHtml(promptTimeoutMinutes) + '"><small class="field-help">单次 ACP prompt 的最长运行时间。默认 30 分钟；超时后任务会记录为失败并释放运行资源。</small></label>' +
      '<label>清理任务周期（秒）<input id="cleanup-interval-seconds" type="number" min="5" max="3600" step="1" value="' + escapeHtml(cleanupIntervalSeconds) + '"><small class="field-help">网关扫描空闲 Session、过期运行记录和临时输入文件的间隔。默认每 60 秒执行一次。</small></label>' +
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

  function renderRuns() {
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
    actions.innerHTML = '<span class="muted">每 5 秒自动刷新</span><button id="refresh-runs" class="button">立即刷新</button>'
    content.innerHTML =
      '<div class="run-summary">' +
        runSummary('当前运行', state.runs.filter((run) => activeStates.has(run.state)).length) +
        runSummary('已完成', completed) +
        runSummary('失败', failed) +
        runSummary('保留记录', state.runTotal) +
      '</div>' +
      '<div class="toolbar"><input id="run-search" type="search" placeholder="搜索任务、智能体或运行 ID" value="' + escapeHtml(state.runSearch) + '">' +
      '<select id="run-agent-filter"><option value="all">全部智能体</option>' + agentOptions + '</select>' +
      '<select id="run-status-filter"><option value="all">全部状态</option><option value="running"' + selected(state.runStatus, 'running') + '>运行中</option><option value="input_required"' + selected(state.runStatus, 'input_required') + '>等待输入</option><option value="permission_required"' + selected(state.runStatus, 'permission_required') + '>等待授权</option><option value="completed"' + selected(state.runStatus, 'completed') + '>已完成</option><option value="failed"' + selected(state.runStatus, 'failed') + '>失败</option><option value="canceled"' + selected(state.runStatus, 'canceled') + '>已取消</option></select></div>' +
      '<section class="run-section"><div class="run-section-title"><h2>当前运行</h2><span>' + active.length + ' 项</span></div>' +
        (active.length ? '<div class="run-live-grid">' + active.map(runCard).join('') + '</div>' : '<div class="panel"><div class="empty">当前没有正在执行或等待处理的任务。</div></div>') +
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

  function runSummary(label, value) {
    return '<div class="run-summary-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
  }

  function runCard(run) {
    const waiting = run.state === 'input_required' || run.state === 'permission_required'
    return '<article class="run-card' + (waiting ? ' waiting' : '') + '" data-run-detail="' + escapeHtml(run.id) + '" tabindex="0"><div class="run-card-head"><div class="run-card-agent"><span class="badge">' + escapeHtml(run.protocol.toUpperCase()) + '</span><strong>' + escapeHtml(run.agentName) + '</strong></div>' + runStatus(run.state) + '</div><div class="run-task">' + escapeHtml(run.task) + '</div><div class="run-progress"><strong>' + escapeHtml(run.progress && run.progress.phase || '运行中') + '</strong><small>' + escapeHtml(run.progress && run.progress.message || '等待最新进度') + '</small></div><div class="run-meta"><span>' + escapeHtml(shortId(run.id)) + '</span><span>' + escapeHtml(formatDuration(run)) + '</span></div></article>'
  }

  function runRow(run) {
    return '<tr data-run-detail="' + escapeHtml(run.id) + '"><td><div class="agent-name"><strong>' + escapeHtml(run.agentName) + '</strong><small>' + escapeHtml(run.protocol.toUpperCase()) + '</small></div></td><td class="run-task-cell"><strong>' + escapeHtml(run.task) + '</strong><small class="run-id">' + escapeHtml(shortId(run.id)) + '</small></td><td class="run-task-cell"><strong>' + escapeHtml(run.resultSummary || run.error || '—') + '</strong><small>' + escapeHtml(run.progress && run.progress.phase || '') + '</small></td><td>' + runStatus(run.state) + '</td><td>' + escapeHtml(formatDate(run.startedAt)) + '</td><td>' + escapeHtml(formatDuration(run)) + '</td></tr>'
  }

  function runStatus(value) {
    const labels = { created: '已创建', running: '运行中', input_required: '等待输入', permission_required: '等待授权', completed: '已完成', failed: '失败', canceled: '已取消' }
    const style = value === 'completed' ? ' completed' : value === 'failed' ? ' failed' : value === 'running' ? ' running' : (value === 'input_required' || value === 'permission_required') ? ' waiting' : ' canceled'
    return '<span class="status' + style + '">' + escapeHtml(labels[value] || value) + '</span>'
  }

  function shortId(value) {
    return String(value || '').slice(0, 8)
  }

  function formatDuration(run) {
    const ms = run.durationMs != null ? run.durationMs : Math.max(0, Date.now() - run.startedAt)
    if (ms < 1000) return ms + ' 毫秒'
    if (ms < 60_000) return Math.round(ms / 1000) + ' 秒'
    if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分 ' + Math.round(ms % 60_000 / 1000) + ' 秒'
    return Math.floor(ms / 3_600_000) + ' 小时 ' + Math.round(ms % 3_600_000 / 60_000) + ' 分'
  }

  async function openRunDrawer(id) {
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

  function detailItem(label, value) {
    return '<div class="run-detail-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
  }

  function runStatusLabel(value) {
    return { created: '已创建', running: '运行中', input_required: '等待输入', permission_required: '等待授权', completed: '已完成', failed: '失败', canceled: '已取消' }[value] || value
  }

  function renderOverview() {
    const agents = readinessRows()
    const ready = agents.filter((agent) => agent.ready).length
    actions.innerHTML = '<button id="refresh-overview" class="button">刷新</button>'
    content.innerHTML =
      '<div class="stats">' +
        stat('智能体', agents.length) +
        stat('就绪', ready) +
        stat('会话', state.sessions) +
      '</div>' +
      '<div class="panel"><div class="panel-header"><h2>智能体</h2><span class="muted">每 20 秒自动检查</span></div>' +
        (agents.length
          ? '<div class="panel-body overview-list">' + agents.map(overviewAgent).join('') + '</div>'
          : '<div class="empty">尚未配置智能体。</div>') +
      '</div>'
    byId('refresh-overview').onclick = () => refreshReadiness(true)
  }

  function stat(label, value) {
    return '<div class="stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
  }

  function readinessRows() {
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

  function renderAgents() {
    actions.innerHTML = '<button id="refresh-agents" class="button">刷新</button><button id="add-agent" class="button primary">添加智能体</button>'
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
      '<div class="toolbar"><input id="agent-search" type="search" placeholder="搜索智能体" value="' + escapeHtml(state.search) + '">' +
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

  function agentRow(agent, live) {
    const statusAgent = live || { ready: false, enabled: agent.enabled, checking: true }
    return '<tr><td><div class="agent-name"><strong>' + escapeHtml(agent.name) + '</strong><small>' + escapeHtml(agent.id) + '</small>' +
      (statusAgent.error && agent.enabled ? '<span class="error-detail">' + escapeHtml(localizeError(statusAgent.error)) + '</span>' : '') +
      '</div></td><td><span class="badge">' + escapeHtml(agent.protocol.toUpperCase()) + '</span></td><td>' + escapeHtml(agent.driver || '—') + '</td><td>' + statusMarkup(statusAgent) + '</td><td>' + escapeHtml(agent.workspace || '—') + '</td><td>' + escapeHtml(permissionLabel(agent.permissionPolicy)) + '</td><td><div class="row-actions"><button class="button small" data-agent-edit="' + escapeHtml(agent.id) + '">编辑</button><button class="button small danger" data-agent-delete="' + escapeHtml(agent.id) + '">删除</button></div></td></tr>'
  }

  function permissionLabel(value) {
    if (value === 'ask') return '询问'
    if (value === 'deny') return '拒绝'
    return value || '—'
  }

  function statusMarkup(agent) {
    if (!agent.enabled) return '<span class="status">已禁用</span>'
    if (agent.checking) return '<span class="status checking">检查中</span>'
    return agent.ready ? '<span class="status ready">就绪</span>' : '<span class="status failed">不可用</span>'
  }

  function renderWorkspaces() {
    actions.innerHTML = '<button id="add-workspace" class="button primary">添加工作区</button>'
    const roots = state.config.workspaceRoots || []
    content.innerHTML = '<div class="workspace-list">' +
      roots.map((root, index) => '<div class="list-row"><div class="list-row-main"><strong class="path">' + escapeHtml(root) + '</strong><small>ACP 会话允许访问的根目录</small></div><div class="row-actions"><button class="button small" data-workspace-edit="' + index + '">编辑</button><button class="button small danger" data-workspace-delete="' + index + '"' + (roots.length === 1 ? ' disabled' : '') + '>删除</button></div></div>').join('') +
      '</div><div class="tip">建议仅添加必要的最小目录范围。启动 ACP 会话前，Agent Nexus 会解析并校验真实路径。</div>'
    byId('add-workspace').onclick = () => openWorkspaceDrawer()
  }

  function renderApiKeys() {
    closeKeyActionMenu()
    actions.innerHTML = '<button id="create-key" class="button primary">创建 API 密钥</button>'
    content.innerHTML = state.apiKeys.length
      ? '<div class="table-wrap key-table-wrap"><table class="key-table"><thead><tr><th>名称</th><th>状态</th><th>API 密钥</th><th>授权范围</th><th>最后使用</th><th class="key-actions-heading">操作</th></tr></thead><tbody>' + state.apiKeys.map(keyRow).join('') + '</tbody></table></div>'
      : '<div class="panel"><div class="empty">尚未创建 API 密钥。客户端需要访问时再创建即可。</div></div>'
    byId('create-key').onclick = () => openKeyDrawer()
  }

  function keyRow(key) {
    const scope = key.scope.allAgents ? '全部智能体' : (key.scope.agentIds.length ? key.scope.agentIds.join(', ') : '未授权智能体')
    const name = key.legacy && key.name === 'Legacy Access Key' ? '旧版访问密钥' : key.name
    const id = escapeHtml(key.id)
    const toggleLabel = key.enabled ? '禁用密钥' : '启用密钥'
    return '<tr><td><div class="agent-name"><strong>' + escapeHtml(name) + '</strong><small>' + (key.legacy ? '从旧版配置迁移' : '创建于 ' + formatDate(key.createdAt)) + '</small></div></td>' +
      '<td>' + (key.enabled ? '<span class="status ready">已启用</span>' : '<span class="status">已禁用</span>') + '</td>' +
      '<td><div class="key-secret-cell"><code>••••' + escapeHtml(key.suffix) + '</code><button class="key-copy-button" data-key-action="copy" data-key-id="' + id + '" aria-label="复制完整密钥" title="复制完整密钥">' + actionIcons.copy + '</button></div></td>' +
      '<td><span class="key-scope">' + escapeHtml(scope) + '</span></td>' +
      '<td><span class="key-last-used">' + escapeHtml(key.lastUsedAt ? formatDate(key.lastUsedAt) : '从未使用') + '</span></td>' +
      '<td class="key-actions-cell"><div class="key-actions"><button class="key-icon-button' + (key.enabled ? ' danger-action' : '') + '" data-key-action="toggle" data-key-id="' + id + '" aria-label="' + toggleLabel + '" title="' + toggleLabel + '">' + (key.enabled ? actionIcons.disable : actionIcons.enable) + '</button><button class="key-icon-button" data-key-action="rename" data-key-id="' + id + '" aria-label="重命名" title="重命名">' + actionIcons.edit + '</button><button class="key-icon-button" data-key-menu="' + id + '" aria-label="更多操作" title="更多操作" aria-expanded="false">' + actionIcons.more + '</button></div></td></tr>'
  }

  function toggleKeyActionMenu(anchor, id) {
    if (!keyActionMenu.classList.contains('hidden') && keyActionMenu.dataset.keyId === id) {
      closeKeyActionMenu()
      return
    }
    closeKeyActionMenu()
    keyActionMenu.dataset.keyId = id
    keyActionMenu.innerHTML =
      '<button type="button" role="menuitem" data-key-action="reveal" data-key-id="' + escapeHtml(id) + '">' + actionIcons.reveal + '<span>显示完整密钥</span></button>' +
      '<button type="button" role="menuitem" data-key-action="scope" data-key-id="' + escapeHtml(id) + '">' + actionIcons.scope + '<span>编辑授权范围</span></button>' +
      '<button type="button" role="menuitem" data-key-action="regenerate" data-key-id="' + escapeHtml(id) + '">' + actionIcons.regenerate + '<span>重新生成密钥</span></button>' +
      '<button type="button" role="menuitem" class="danger-text" data-key-action="delete" data-key-id="' + escapeHtml(id) + '">' + actionIcons.delete + '<span>删除密钥</span></button>'
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

  function closeKeyActionMenu() {
    keyActionMenu.classList.add('hidden')
    keyActionMenu.innerHTML = ''
    keyActionMenu.dataset.keyId = ''
    document.querySelectorAll('[data-key-menu][aria-expanded="true"]').forEach((button) => button.setAttribute('aria-expanded', 'false'))
  }

  function openDrawer(title, body, submitLabel, onSubmit) {
    byId('drawer-title').textContent = title
    drawerForm.innerHTML = body + '<div class="drawer-footer"><button type="button" class="button" data-close-drawer>取消</button>' + (submitLabel ? '<button type="submit" class="button primary">' + escapeHtml(submitLabel) + '</button>' : '') + '</div><p class="form-error" data-form-error></p>'
    drawerSubmit = onSubmit || null
    drawer.classList.remove('hidden')
    drawerBackdrop.classList.remove('hidden')
    const first = drawerForm.querySelector('input, select, textarea')
    if (first) setTimeout(() => first.focus(), 0)
  }

  function closeDrawer() {
    drawer.classList.add('hidden')
    drawerBackdrop.classList.add('hidden')
    drawerForm.innerHTML = ''
    drawerSubmit = null
  }

  function openAgentDrawer(agent) {
    const editing = Boolean(agent)
    const current = agent || { protocol: 'acp', enabled: true, permissionPolicy: 'ask', permissionTimeoutMs: 900000, timeoutMs: 60000 }
    const drivers = state.config.driverKinds.map((driver) => '<option value="' + escapeHtml(driver) + '"' + selected(current.driver || state.config.driverKinds[0], driver) + '>' + escapeHtml(driver) + '</option>').join('')
    const roots = state.config.workspaceRoots.map((root) => '<option value="' + escapeHtml(root) + '"></option>').join('')
    const body =
      '<label>智能体 ID<input name="id" value="' + escapeHtml(current.id || '') + '" pattern="[a-z0-9][a-z0-9._\\-]{0,63}" required' + (editing ? ' disabled' : '') + '></label>' +
      '<div class="field-row"><label>协议<select name="protocol"><option value="acp"' + selected(current.protocol, 'acp') + '>ACP</option><option value="a2a"' + selected(current.protocol, 'a2a') + '>A2A</option></select></label><label class="checkbox"><input name="enabled" type="checkbox"' + checked(current.enabled) + '>启用</label></div>' +
      '<label>名称<input name="name" value="' + escapeHtml(current.name || '') + '" required></label>' +
      '<label>描述<textarea name="description">' + escapeHtml(current.description || '') + '</textarea></label>' +
      '<div data-protocol-section="acp"><label>驱动<select name="driver">' + drivers + '</select></label><label>工作区<input name="workspace" list="workspace-roots" value="' + escapeHtml(current.workspace || state.config.workspaceRoots[0] || '') + '" required><datalist id="workspace-roots">' + roots + '</datalist></label><div class="field-row"><label>权限策略<select name="permissionPolicy"><option value="ask"' + selected(current.permissionPolicy, 'ask') + '>询问</option><option value="deny"' + selected(current.permissionPolicy, 'deny') + '>拒绝</option></select></label><label>权限确认超时（毫秒）<input name="permissionTimeoutMs" type="number" min="1000" value="' + escapeHtml(current.permissionTimeoutMs || 900000) + '"></label></div></div>' +
      '<div data-protocol-section="a2a"><label>Agent Card URL<input name="agentCardUrl" type="url" value="' + escapeHtml(current.agentCardUrl || '') + '" placeholder="http://agent.local:8080/.well-known/agent-card.json" required><small class="field-help">填写完整的 Agent Card JSON 地址；调用地址和能力将从 Card 自动发现。</small></label><div class="field-row"><label>首选传输<select name="preferredTransport"><option value="auto"' + selected(current.preferredTransport || 'auto', 'auto') + '>自动（按 Card）</option><option value="jsonrpc"' + selected(current.preferredTransport, 'jsonrpc') + '>JSON-RPC</option><option value="http-json"' + selected(current.preferredTransport, 'http-json') + '>HTTP+JSON</option></select></label><label>认证方式<select name="authType"><option value="none"' + selected(current.auth && current.auth.type || 'none', 'none') + '>无认证</option><option value="bearer"' + selected(current.auth && current.auth.type, 'bearer') + '>Bearer Token</option><option value="header"' + selected(current.auth && current.auth.type, 'header') + '>自定义请求头</option></select></label></div><label data-auth-header>请求头名称<input name="authHeaderName" value="' + escapeHtml(current.auth && current.auth.headerName || '') + '" placeholder="X-API-Key"></label><label data-auth-value><span data-auth-value-label>认证凭据</span><input name="authValue" type="password" autocomplete="off" placeholder="' + (editing && current.auth && current.auth.configured ? '留空以保留当前凭据' : '') + '"></label><label>请求超时（毫秒）<input name="timeoutMs" type="number" min="1000" max="1800000" value="' + escapeHtml(current.timeoutMs || 60000) + '"><small class="field-help">默认 60 秒；用于限制这个 A2A Agent 的单次请求，最大 30 分钟。</small></label></div>'
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
        payload.permissionTimeoutMs = Number(data.get('permissionTimeoutMs'))
      } else {
        payload.agentCardUrl = String(data.get('agentCardUrl') || '').trim()
        payload.preferredTransport = data.get('preferredTransport')
        payload.authType = data.get('authType')
        payload.authHeaderName = String(data.get('authHeaderName') || '').trim()
        const authValue = String(data.get('authValue') || '')
        if (authValue) payload.authValue = authValue
        payload.timeoutMs = Number(data.get('timeoutMs'))
      }
      await api('/v1/admin/agents/' + encodeURIComponent(id), { method: 'PUT', body: payload })
      closeDrawer()
      await loadAll(true)
      render()
      toast(editing ? '智能体已更新' : '智能体已添加')
    })
    const protocolSelect = drawerForm.elements.protocol
    const authSelect = drawerForm.elements.authType
    const sync = () => {
      drawerForm.querySelectorAll('[data-protocol-section]').forEach((section) => {
        section.classList.toggle('hidden', section.dataset.protocolSection !== protocolSelect.value)
        section.querySelectorAll('input,select,textarea').forEach((field) => { field.disabled = section.classList.contains('hidden') })
      })
      if (protocolSelect.value === 'a2a') {
        const auth = authSelect.value
        drawerForm.querySelector('[data-auth-header]').classList.toggle('hidden', auth !== 'header')
        drawerForm.querySelector('[data-auth-value]').classList.toggle('hidden', auth === 'none')
        drawerForm.querySelector('[data-auth-value-label]').textContent = auth === 'bearer' ? 'Bearer Token' : '认证凭据'
      }
    }
    protocolSelect.onchange = sync
    authSelect.onchange = sync
    sync()
  }

  function openWorkspaceDrawer(index) {
    const editing = Number.isInteger(index)
    const current = editing ? state.config.workspaceRoots[index] : ''
    openDrawer(editing ? '编辑工作区' : '添加工作区', '<label>允许访问的根目录<input name="path" value="' + escapeHtml(current) + '" required></label>', editing ? '保存修改' : '添加工作区', async (form) => {
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

  function openKeyDrawer() {
    const scopeRows = state.config.agents.map((agent) => '<label class="checkbox"><input type="checkbox" name="agentId" value="' + escapeHtml(agent.id) + '">' + escapeHtml(agent.name) + ' <span class="muted">(' + escapeHtml(agent.protocol.toUpperCase()) + ')</span></label>').join('')
    const body = '<label>名称<input name="name" required placeholder="例如：开发客户端"></label><label class="checkbox"><input id="all-agents" name="allAgents" type="checkbox" checked>允许访问全部智能体</label><div id="agent-scope" class="agent-scope hidden">' + (scopeRows || '<span class="muted">尚未配置智能体。</span>') + '</div><label>自定义密钥（可选）<input name="customSecret" minlength="16" autocomplete="off" placeholder="留空则自动生成 nx_sk_ 密钥"></label>'
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

  function showSecret(title, secret) {
    openDrawer(title, '<div class="secret-box"><span class="muted">请立即复制此密钥；之后也可在 API 密钥页面再次显示。</span><code class="secret-value" id="secret-value">' + escapeHtml(secret) + '</code><button class="button" type="button" id="copy-secret">复制</button></div>', '', null)
    byId('copy-secret').onclick = async () => {
      try {
        await copySecret(secret)
        toast('API 密钥已复制')
      } catch (error) { toast(error.message, true) }
    }
  }

  async function copySecret(secret) {
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

  function openPasswordDrawer() {
    openDrawer('修改控制台密码', '<label>当前密码<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>新密码<input name="newPassword" type="password" minlength="12" autocomplete="new-password" required></label><label>确认新密码<input name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required></label>', '修改密码', async (form) => {
      const data = new FormData(form)
      await api('/v1/admin/password', { method: 'PUT', body: { currentPassword: String(data.get('currentPassword') || ''), newPassword: String(data.get('newPassword') || ''), confirmPassword: String(data.get('confirmPassword') || '') } })
      closeDrawer()
      showLogin()
      toast('控制台密码已修改，请重新登录。')
    })
  }

  async function handleContentClick(event) {
    const runTarget = event.target.closest('[data-run-detail]')
    if (runTarget) {
      await runAction(() => openRunDrawer(runTarget.dataset.runDetail))
      return
    }
    const button = event.target.closest('button')
    if (!button) return
    if (button.dataset.keyMenu) {
      toggleKeyActionMenu(button, button.dataset.keyMenu)
      return
    }
    if (button.dataset.agentEdit) {
      openAgentDrawer(state.config.agents.find((agent) => agent.id === button.dataset.agentEdit))
      return
    }
    if (button.dataset.agentDelete) {
      if (!confirm('确定删除此智能体吗？已有会话不会被修改。')) return
      await runAction(async () => {
        state.config = await api('/v1/admin/agents/' + encodeURIComponent(button.dataset.agentDelete), { method: 'DELETE' })
        await loadAll(true)
        render()
        toast('智能体已删除')
      })
      return
    }
    if (button.dataset.workspaceEdit !== undefined) {
      openWorkspaceDrawer(Number(button.dataset.workspaceEdit))
      return
    }
    if (button.dataset.workspaceDelete !== undefined) {
      const index = Number(button.dataset.workspaceDelete)
      if (!confirm('确定移除此工作区根目录吗？')) return
      await runAction(async () => {
        const roots = state.config.workspaceRoots.filter((_, itemIndex) => itemIndex !== index)
        state.config = await api('/v1/admin/config/workspace-roots', { method: 'PUT', body: { workspaceRoots: roots } })
        render()
        toast('工作区已移除')
      })
      return
    }
    if (button.dataset.keyAction) await handleKeyAction(button.dataset.keyAction, button.dataset.keyId)
  }

  async function handleKeyAction(action, id) {
    const key = state.apiKeys.find((item) => item.id === id)
    if (!key) return
    await runAction(async () => {
      if (action === 'copy') {
        const value = await api('/v1/admin/api-keys/' + encodeURIComponent(id) + '/reveal', { method: 'POST' })
        await copySecret(value.secret)
        toast('API 密钥已复制')
      }
      if (action === 'reveal') {
        const value = await api('/v1/admin/api-keys/' + encodeURIComponent(id) + '/reveal', { method: 'POST' })
        showSecret('显示 API 密钥', value.secret)
      }
      if (action === 'rename') {
        const name = prompt('API 密钥名称', key.name)
        if (!name || name === key.name) return
        await api('/v1/admin/api-keys/' + encodeURIComponent(id), { method: 'PATCH', body: { name } })
        await reloadKeys()
        toast('API 密钥已重命名')
      }
      if (action === 'scope') {
        openKeyScopeDrawer(key)
      }
      if (action === 'toggle') {
        await api('/v1/admin/api-keys/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: !key.enabled } })
        await reloadKeys()
        toast(key.enabled ? 'API 密钥已禁用' : 'API 密钥已启用')
      }
      if (action === 'regenerate') {
        if (!confirm('确定重新生成此 API 密钥吗？当前密钥将立即失效。')) return
        const value = await api('/v1/admin/api-keys/' + encodeURIComponent(id) + '/regenerate', { method: 'POST' })
        await reloadKeys()
        showSecret('API 密钥已重新生成', value.secret)
      }
      if (action === 'delete') {
        if (!confirm('确定删除此 API 密钥吗？此操作无法撤销。')) return
        await api('/v1/admin/api-keys/' + encodeURIComponent(id), { method: 'DELETE' })
        await reloadKeys()
        toast('API 密钥已删除')
      }
    })
  }

  function openKeyScopeDrawer(key) {
    const selectedIds = new Set(key.scope.agentIds || [])
    const scopeRows = state.config.agents.map((agent) => '<label class="checkbox"><input type="checkbox" name="agentId" value="' + escapeHtml(agent.id) + '"' + checked(selectedIds.has(agent.id)) + '>' + escapeHtml(agent.name) + ' <span class="muted">(' + escapeHtml(agent.protocol.toUpperCase()) + ')</span></label>').join('')
    const body = '<label class="checkbox"><input id="edit-all-agents" name="allAgents" type="checkbox"' + checked(key.scope.allAgents) + '>允许访问全部智能体</label><div id="edit-agent-scope" class="agent-scope' + (key.scope.allAgents ? ' hidden' : '') + '">' + (scopeRows || '<span class="muted">尚未配置智能体。</span>') + '</div>'
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

  async function reloadKeys() {
    const value = await api('/v1/admin/api-keys')
    state.apiKeys = value.apiKeys || []
    render()
  }

  async function runAction(task) {
    try { await task() } catch (error) { toast(error.message, true) }
  }

  function formatDate(timestamp) {
    if (!timestamp) return '—'
    return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))
  }

  function toast(message, error) {
    const item = document.createElement('div')
    item.className = 'toast' + (error ? ' error' : '')
    item.textContent = message
    byId('toast-region').appendChild(item)
    setTimeout(() => item.remove(), 4200)
  }

  function applyTheme(preference) {
    const theme = preference === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : preference
    document.documentElement.dataset.theme = theme
    const select = byId('theme-select')
    if (select) select.value = preference
  }

  byId('setup-form').onsubmit = async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const error = form.querySelector('[data-form-error]')
    error.textContent = ''
    const data = new FormData(form)
    try {
      await api('/v1/bootstrap/initialize', { method: 'POST', body: { password: String(data.get('password') || ''), confirmPassword: String(data.get('confirmPassword') || '') } })
      form.reset()
      showLogin()
      toast('初始化完成，请使用控制台密码登录。')
    } catch (reason) { error.textContent = reason.message }
  }

  byId('login-form').onsubmit = async (event) => {
    event.preventDefault()
    const form = event.currentTarget
    const error = form.querySelector('[data-form-error]')
    error.textContent = ''
    try {
      const data = new FormData(form)
      await api('/v1/admin/auth/login', { method: 'POST', body: { password: String(data.get('password') || '') } })
      form.reset()
      await enterApp()
    } catch (reason) { error.textContent = reason.message }
  }

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.onclick = () => {
      state.page = item.dataset.page
      render()
      if (state.page === 'runs') void refreshRuns(false)
    }
  })
  content.addEventListener('click', (event) => { void handleContentClick(event) })
  keyActionMenu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-key-action]')
    if (!button) return
    closeKeyActionMenu()
    void handleKeyAction(button.dataset.keyAction, button.dataset.keyId)
  })
  drawerForm.onsubmit = async (event) => {
    event.preventDefault()
    if (!drawerSubmit) return
    const error = drawerForm.querySelector('[data-form-error]')
    error.textContent = ''
    try { await drawerSubmit(drawerForm) } catch (reason) { error.textContent = reason.message }
  }
  drawerForm.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-drawer]')) closeDrawer()
  })
  byId('drawer-close').onclick = closeDrawer
  drawerBackdrop.onclick = closeDrawer

  byId('admin-menu').onclick = () => {
    const popover = byId('admin-popover')
    const hidden = popover.classList.toggle('hidden')
    byId('admin-menu').setAttribute('aria-expanded', String(!hidden))
  }
  byId('theme-select').onchange = (event) => {
    localStorage.setItem('agent-nexus-theme', event.target.value)
    applyTheme(event.target.value)
  }
  byId('change-password').onclick = () => { byId('admin-popover').classList.add('hidden'); openPasswordDrawer() }
  byId('logout').onclick = async () => {
    await runAction(async () => {
      await api('/v1/admin/auth/logout', { method: 'POST' })
      showLogin()
    })
  }
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.admin-menu-wrap')) byId('admin-popover').classList.add('hidden')
    if (!event.target.closest('.key-action-menu') && !event.target.closest('[data-key-menu]')) closeKeyActionMenu()
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem('agent-nexus-theme') || 'system') === 'system') applyTheme('system')
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeKeyActionMenu()
      closeDrawer()
    }
  })
  window.addEventListener('resize', closeKeyActionMenu)
  window.addEventListener('scroll', closeKeyActionMenu, true)

  setInterval(() => {
    if (state.authenticated) void refreshReadiness(false)
  }, 20_000)

  setInterval(() => {
    if (state.authenticated && state.page === 'runs') void refreshRuns(false)
  }, 5_000)

  void boot()
})()
`
