import { state } from './state.js'
import { byId, pageStats, drawerForm, escapeHtml, selected } from './dom.js'
import { icons } from './icons.js'
import { api } from './api.js'
import { withBusy, toast, runAction } from './toast.js'
import { openDrawer, getDrawerVersion, openConfirmDrawer } from './drawer.js'
import { copySecret } from './render-keys.js'
import { writeLocationState } from './location-state.js'

import { refreshRuns } from './data.js'
import { shortId, formatDate, formatDuration, runStatusLabel } from './format.js'

import { setResults, setActions, setToolbar, announce, stat, emptyState, bindSearch } from './render-shared.js'

let runSearchTimer
let activeRunDrawer = null
export function resetRunView() { clearTimeout(runSearchTimer); activeRunDrawer = null }

export function runStatus(value) {
  const style = value === 'completed' ? ' completed' : value === 'failed' ? ' failed' : value === 'running' ? ' running' : (value === 'input_required' || value === 'permission_required') ? ' waiting' : ' canceled'
  return '<span class="status' + style + '">' + escapeHtml(runStatusLabel(value)) + '</span>'
}

export function runTaskPreview(run) {
  return run.taskPreview || run.task || '—'
}

export function runCard(run) {
  const waiting = run.state === 'input_required' || run.state === 'permission_required'
  const progress = run.progress || {}
  return '<article class="run-card' + (waiting ? ' waiting' : '') + '"><div class="run-card-head"><div class="run-card-agent"><span class="badge">' + escapeHtml((run.protocol || '').toUpperCase()) + '</span><strong>' + escapeHtml(run.agentName) + '</strong></div>' + runStatus(run.state) + '</div><div class="run-task">' + escapeHtml(runTaskPreview(run)) + '</div>' +
    (progress.phase || progress.message ? '<div class="run-progress">' + (progress.phase ? '<strong>' + escapeHtml(progress.phase) + '</strong>' : '') + (progress.message ? '<small>' + escapeHtml(progress.message) + '</small>' : '') + '</div>' : '') +
    '<div class="run-meta"><span>' + escapeHtml(shortId(run.id)) + '</span><span>' + escapeHtml(formatDuration(run)) + '</span></div>' + runDetailButton(run) + '</article>'
}

export function runDetailButton(run) {
  return '<button type="button" class="button small run-detail-button" data-run-detail="' + escapeHtml(run.id) + '" aria-label="查看运行详情：' + escapeHtml(runTaskPreview(run)) + '">查看详情</button>'
}

export function runRow(run) {
  return '<tr><td><div class="agent-name"><strong>' + escapeHtml(run.agentName) + '</strong><small>' + escapeHtml((run.protocol || '').toUpperCase()) + '</small></div></td><td class="run-task-cell"><strong>' + escapeHtml(runTaskPreview(run)) + '</strong><small class="run-id">' + escapeHtml(shortId(run.id)) + '</small></td><td class="run-task-cell"><strong>' + escapeHtml(run.resultSummary || run.error || '—') + '</strong><small>' + escapeHtml(run.progress && run.progress.phase || '') + '</small></td><td>' + runStatus(run.state) + '</td><td class="num">' + escapeHtml(formatDate(run.startedAt)) + '</td><td class="num">' + escapeHtml(formatDuration(run)) + '</td><td>' + runDetailButton(run) + '</td></tr>'
}

export function renderRuns() {
  writeLocationState(state)
  const pageSize = state.runPageSize || 50
  const activeStates = new Set(['running', 'input_required', 'permission_required'])
  const filtered = state.runs.filter((run) => {
    const haystack = (runTaskPreview(run) + ' ' + (run.agentName || '') + ' ' + run.id).toLowerCase()
    // The server searches the retained full task. A list response may only
    // contain taskPreview, so do not hide a server-matched row locally.
    const localSearchMatches = !state.runSearch || !run.task && run.taskPreview || haystack.indexOf(state.runSearch.toLowerCase()) >= 0
    return localSearchMatches &&
      (state.runAgent === 'all' || run.agentId === state.runAgent) &&
      (state.runStatus === 'all' || run.state === state.runStatus)
  })
  const active = filtered.filter((run) => activeStates.has(run.state))
  const history = filtered.filter((run) => !activeStates.has(run.state))
  const agentOptions = state.config.agents.map((agent) => '<option value="' + escapeHtml(agent.id) + '"' + selected(state.runAgent, agent.id) + '>' + escapeHtml(agent.name) + '</option>').join('')
  setActions('<button id="refresh-runs" class="button">' + icons.refresh + '刷新</button>')
  byId('refresh-runs').onclick = (event) => withBusy(event.currentTarget, () => refreshRuns(true))

  if (!state.runs.length && state.resources.runs.status === 'loading') {
    pageStats.innerHTML = ''
    setToolbar('')
    setResults('<div class="panel"><p class="panel-note">正在加载运行记录…</p></div>')
    announce('正在加载运行记录')
    return
  }

  if (!state.runs.length && !state.runSearch && state.runAgent === 'all' && state.runStatus === 'all' && !state.runOffset) {
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
  const hasFilters = Boolean(state.runSearch || state.runAgent !== 'all' || state.runStatus !== 'all')
  const pageSizes = [50, 100, 200].map((size) => '<option value="' + size + '"' + selected(pageSize, size) + '>' + size + ' 条/页</option>').join('')
  setToolbar('runs|' + pageSize + '|' + JSON.stringify(state.config.agents.map((agent) => [agent.id, agent.name])),
    '<div class="toolbar"><div class="search-box">' + icons.search + '<input id="run-search" type="search" aria-label="搜索运行记录" placeholder="搜索任务、智能体或运行 ID" value="' + escapeHtml(state.runSearch) + '"></div>' +
    '<select id="run-agent-filter" aria-label="按智能体筛选"><option value="all">全部智能体</option>' + agentOptions + '</select>' +
    '<select id="run-status-filter" aria-label="按运行状态筛选"><option value="all">全部状态</option><option value="running"' + selected(state.runStatus, 'running') + '>运行中</option><option value="input_required"' + selected(state.runStatus, 'input_required') + '>等待输入</option><option value="permission_required"' + selected(state.runStatus, 'permission_required') + '>等待授权</option><option value="completed"' + selected(state.runStatus, 'completed') + '>已完成</option><option value="failed"' + selected(state.runStatus, 'failed') + '>失败</option><option value="canceled"' + selected(state.runStatus, 'canceled') + '>已取消</option></select>' +
    '<select id="run-page-size" aria-label="每页运行记录数">' + pageSizes + '</select><button class="button small" id="clear-run-filters">清除筛选</button></div>')
  byId('clear-run-filters').hidden = !hasFilters
  const searchInput = byId('run-search')
  if (!searchInput.dataset.composing && searchInput.value !== state.runSearch) searchInput.value = state.runSearch
  byId('run-agent-filter').value = state.runAgent
  byId('run-status-filter').value = state.runStatus
  const first = state.runTotal ? state.runOffset + 1 : 0
  const last = Math.min(state.runOffset + pageSize, state.runTotal)
  setResults((state.runHasNew ? '<p class="panel-note"><button class="button small" id="runs-show-new">有新任务，返回首页查看</button></p>' : '') + '<div class="run-pagination"><span class="muted">在已保留的全部记录中筛选 · 显示 ' + first + '–' + last + '，共 ' + state.runTotal + ' 条 · 第 ' + (Math.floor(state.runOffset / pageSize) + 1) + ' 页</span><div class="row-actions"><button class="button small" id="runs-prev"' + (state.runOffset ? '' : ' disabled') + '>上一页</button><button class="button small" id="runs-next"' + (state.runOffset + pageSize < state.runTotal ? '' : ' disabled') + '>下一页</button></div></div>' +
    '<section class="run-section"><div class="run-section-title"><h2>当前运行</h2><span>' + active.length + ' 项</span></div>' +
      (active.length ? '<div class="run-live-grid">' + active.map(runCard).join('') + '</div>' : '<div class="panel">' + emptyState(icons.activity, '当前没有任务') + '</div>') +
    '</section>' +
    '<section class="run-section"><div class="run-section-title"><h2>历史记录</h2><span>' + history.length + ' 项</span></div>' +
      '<div class="table-wrap"><table class="run-table"><thead><tr><th>智能体</th><th>任务</th><th>结果</th><th>状态</th><th class="num">开始时间</th><th class="num">耗时</th><th>操作</th></tr></thead><tbody>' +
      (history.length ? history.map(runRow).join('') : '<tr><td colspan="7" class="empty">没有符合条件的历史记录。</td></tr>') +
      '</tbody></table></div></section>')
  const filterChanged = () => {
    state.runOffset = 0
    state.runHasNew = false
    clearTimeout(runSearchTimer)
    renderRuns()
    runSearchTimer = setTimeout(() => { if (state.authenticated) void refreshRuns(false) }, 250)
  }
  bindSearch('run-search', (value) => { state.runSearch = value; filterChanged() })
  byId('run-agent-filter').onchange = (event) => { state.runAgent = event.target.value; filterChanged() }
  byId('run-status-filter').onchange = (event) => { state.runStatus = event.target.value; filterChanged() }
  byId('run-page-size').onchange = (event) => { state.runPageSize = Math.min(200, Math.max(50, Number(event.target.value) || 50)); state.runOffset = 0; void refreshRuns(true) }
  byId('clear-run-filters').onclick = () => {
    clearTimeout(runSearchTimer)
    state.runSearch = ''
    state.runAgent = 'all'
    state.runStatus = 'all'
    state.runOffset = 0
    renderRuns()
    void refreshRuns(true)
  }
  byId('runs-prev').onclick = (event) => withBusy(event.currentTarget, async () => { state.runOffset = Math.max(0, state.runOffset - pageSize); await refreshRuns(true) })
  byId('runs-next').onclick = (event) => withBusy(event.currentTarget, async () => { state.runOffset += pageSize; await refreshRuns(true) })
  if (byId('runs-show-new')) byId('runs-show-new').onclick = () => { state.runOffset = 0; state.runHasNew = false; void refreshRuns(true) }
  announce(active.length + ' 项当前运行，' + history.length + ' 项历史记录')
}

export function detailItem(label, value) {
  return '<div class="run-detail-item"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
}

export async function openRunDrawer(id) {
  openDrawer('运行详情', '<p role="status">正在加载运行详情…</p>', '', null)
  state.selectedRunId = id
  writeLocationState(state)
  drawerForm.setAttribute('aria-busy', 'true')
  activeRunDrawer = { id, version: getDrawerVersion(), busy: false, html: '', revision: 0, actionBusy: false }
  await refreshOpenRunDrawer()
}

export async function refreshOpenRunDrawer() {
  const target = activeRunDrawer
  if (!target || target.version !== getDrawerVersion() || target.busy || target.actionBusy) return
  const { id, version, revision } = target
  target.busy = true
  try {
    const run = await api('/v1/admin/runs/' + encodeURIComponent(id))
    if (version !== getDrawerVersion() || revision !== target.revision) return
    renderRunDetail(target, run)
    drawerForm.querySelector('[data-detail-error]').textContent = ''
  } catch (error) {
    if (version !== getDrawerVersion() || revision !== target.revision) return
    let warning = drawerForm.querySelector('[data-detail-error]')
    if (!warning) {
      warning = document.createElement('p')
      warning.dataset.detailError = ''
      warning.className = 'form-error'
      warning.setAttribute('role', 'status')
      drawerForm.prepend(warning)
    }
    warning.textContent = '详情刷新失败：' + error.message
  } finally {
    target.busy = false
    if (version === getDrawerVersion()) drawerForm.removeAttribute('aria-busy')
  }
}

function updateDetailText(element, value) {
  const text = String(value ?? '—')
  const old = element.textContent
  if (text === old) return
  if (element.childNodes.length !== 1 || element.firstChild.nodeType !== Node.TEXT_NODE) {
    element.replaceChildren(document.createTextNode(text))
    return
  }
  let prefix = 0
  while (prefix < old.length && prefix < text.length && old[prefix] === text[prefix]) prefix++
  element.firstChild.replaceData(prefix, old.length - prefix, text.slice(prefix))
}

function renderRunDetail(target, run) {
  if (!drawerForm.querySelector('[data-run-detail-body]')) {
    drawerForm.innerHTML = '<div data-run-detail-body>' +
      '<p class="field-help">管理员可介入任意客户端的任务；操作会记录审计日志。重试使用新会话，旧记录保留。</p>' +
      '<div class="run-detail-actions"><button type="button" class="button small" data-run-copy="id">复制运行 ID</button><button type="button" class="button small" data-run-copy="output">复制结果</button><button type="button" class="button small" data-run-copy="error">复制错误</button><button type="button" class="button small danger" data-run-cancel>取消任务</button><button type="button" class="button small" data-run-retry>新会话重试</button><button type="button" class="button small" data-run-refresh>刷新</button></div>' +
      '<p class="field-help" data-controls-reason></p><p class="form-error" data-detail-error role="status"></p>' +
      '<div class="run-detail-grid">' +
      [['agent','智能体'],['state','状态'],['startedAt','开始时间'],['duration','耗时'],['protocol','协议'],['id','运行 ID'],['phase','当前阶段'],['attachments','输入附件'],['retry','重试来源']]
        .map(([field,label]) => '<div class="run-detail-item"><span>' + label + '</span><strong data-detail-field="' + field + '"></strong></div>').join('') +
      '</div><div data-pending-container></div>' +
      '<div class="run-detail-block"><h3>用户任务</h3><pre class="run-detail-code" data-detail-task></pre></div>' +
      '<div class="run-detail-block" data-progress-block><h3>最近进度</h3><pre class="run-detail-code" data-detail-progress></pre></div>' +
      '<div class="run-detail-block" data-output-block><div class="run-output-heading"><h3>智能体结果</h3><label class="checkbox"><input type="checkbox" data-follow-output>跟随最新</label></div><pre class="run-detail-code" data-detail-output></pre></div>' +
      '<div class="run-detail-block" data-error-block><h3>错误</h3><pre class="run-detail-code" data-detail-failure></pre></div>' +
      '<div class="run-detail-block"><h3>产物</h3><div data-detail-artifacts></div></div></div>'
  }
  byId('drawer-title').textContent = '运行详情 · ' + run.agentName
  const fields = { agent: run.agentName, state: runStatusLabel(run.state), startedAt: formatDate(run.startedAt), duration: formatDuration(run), protocol: run.protocol.toUpperCase(), id: run.id, phase: run.progress?.phase || '—', attachments: run.inputAttachmentCount || 0, retry: run.retryOfRunId || '—' }
  for (const [key,value] of Object.entries(fields)) updateDetailText(drawerForm.querySelector('[data-detail-field="' + key + '"]'), value)
  updateDetailText(drawerForm.querySelector('[data-detail-task]'), (run.task || run.taskPreview || '—') + (run.taskTruncated ? '\n\n[记录已截断]' : ''))
  for (const [name,value] of [['progress',run.progress?.message],['output',run.output],['error',run.error]]) {
    drawerForm.querySelector('[data-' + name + '-block]').hidden = !value
    updateDetailText(drawerForm.querySelector(name === 'error' ? '[data-detail-failure]' : '[data-detail-' + name + ']'), value || '')
  }
  const output = drawerForm.querySelector('[data-detail-output]')
  if (drawerForm.querySelector('[data-follow-output]').checked) output.scrollTop = output.scrollHeight
  const artifactLabels = { pending: '保存中', metadata_only: '仅元数据', expired: '已过期', evicted: '已按容量清理', failed: '保存失败' }
  const artifactHtml = run.artifacts?.length ? run.artifacts.map((artifact) =>
    '<div class="list-row"><div class="list-row-main"><strong>' + escapeHtml(artifact.name || artifact.filename || artifact.id || '未命名产物') + '</strong><small>' +
    escapeHtml([artifact.mediaType, artifact.size === undefined ? '' : artifact.size + ' 字节', artifact.downloadable ? '可下载' : artifactLabels[artifact.storageStatus] || '仅元数据'].filter(Boolean).join(' · ')) +
    '</small></div>' + (artifact.downloadable && artifact.id ? '<a class="button small" download href="/v1/admin/runs/' + encodeURIComponent(run.id) + '/artifacts/' + encodeURIComponent(artifact.id) + '">下载</a>' : '') + '</div>'
  ).join('') : '<p class="field-help">暂无产物</p>'
  const artifacts = drawerForm.querySelector('[data-detail-artifacts]')
  if (artifacts.dataset.signature !== artifactHtml) { artifacts.innerHTML = artifactHtml; artifacts.dataset.signature = artifactHtml }
  const controls = run.controls || {}
  const cancel = drawerForm.querySelector('[data-run-cancel]')
  const retry = drawerForm.querySelector('[data-run-retry]')
  cancel.disabled = !controls.canCancel
  retry.disabled = !controls.canRetry
  updateDetailText(drawerForm.querySelector('[data-controls-reason]'), controls.unavailableReason || '')
  drawerForm.querySelector('[data-run-refresh]').onclick = () => { void refreshOpenRunDrawer() }
  cancel.onclick = () => confirmRunAction(run, 'cancel')
  retry.onclick = () => confirmRunAction(run, 'retry')
  for (const button of drawerForm.querySelectorAll('[data-run-copy]')) {
    const value = run[button.dataset.runCopy]
    button.disabled = !value
    button.onclick = () => runAction(async () => { await copySecret(String(value)); toast('已复制') })
  }
  renderPendingControls(target, controls.pendingRequest)
}

function confirmRunAction(run, action) {
  const retry = action === 'retry'
  openConfirmDrawer(retry ? '新会话重试' : '取消任务',
    retry ? '将用原任务文本创建新的会话，使用当前智能体配置。旧记录保留；任务已经产生的外部操作可能重复执行。' : '取消当前任务并释放智能体会话。已经完成的文件或外部操作不会撤回。',
    retry ? '新会话重试' : '取消任务', async (isCurrent) => {
      const result = await api('/v1/admin/runs/' + encodeURIComponent(run.id) + '/' + action, { method: 'POST', body: {} })
      toast(retry ? '已创建重试任务' : '任务已取消')
      void refreshRuns(false)
      if (isCurrent()) await openRunDrawer(retry ? result.runId : run.id)
    })
}

function renderPendingControls(target, pending) {
  const container = drawerForm.querySelector('[data-pending-container]')
  if (!pending) { container.replaceChildren(); delete container.dataset.requestId; return }
  if (container.dataset.requestId === pending.id) return
  container.dataset.requestId = pending.id
  const options = pending.options || []
  container.innerHTML = '<section class="run-pending"><h3>' + (pending.kind === 'permission' ? '等待授权' : '等待补充输入') + '</h3><p class="run-pending-prompt">' + escapeHtml(pending.prompt) + '</p>' +
    (options.length ? '<div class="field"><label for="run-response-option">选择操作</label><select id="run-response-option"><option value="">请选择，不会自动授权</option>' + options.map((option) => '<option value="' + escapeHtml(option.id) + '">' + escapeHtml(option.name + (option.kind?.includes('always') ? '（永久）' : '')) + '</option>').join('') + '</select></div>' : '') +
    (pending.kind === 'input' ? '<div class="field"><label for="run-response-message">补充信息</label><textarea id="run-response-message" rows="4"></textarea></div>' : '') +
    '<div class="row-actions"><button type="button" class="button primary" data-run-respond>提交' + (pending.kind === 'permission' ? '授权选择' : '补充信息') + '</button><button type="button" class="button" data-run-decline>拒绝</button></div><p class="form-error" data-response-error role="alert"></p></section>'
  const submit = async (decline) => {
    if (target.actionBusy) return
    const error = container.querySelector('[data-response-error]')
    error.textContent = ''
    const optionId = container.querySelector('#run-response-option')?.value || ''
    const message = container.querySelector('#run-response-message')?.value || ''
    if (!decline && pending.kind === 'permission' && !optionId) { error.textContent = '请选择要授权或拒绝的操作'; return }
    if (!decline && pending.kind === 'input' && !optionId && !message.trim()) { error.textContent = '请输入补充信息或选择操作'; return }
    target.actionBusy = true
    target.revision++
    container.querySelectorAll('button').forEach((button) => { button.disabled = true })
    try {
      await api('/v1/admin/runs/' + encodeURIComponent(target.id) + '/respond', {
        method: 'POST', body: { requestId: pending.id, ...(decline ? { action: 'decline' } : { action: 'accept', ...(optionId ? { optionId } : {}), ...(message ? { message } : {}) }) }
      })
      toast('已提交，等待智能体继续执行')
      if (target.version === getDrawerVersion()) { container.replaceChildren(); delete container.dataset.requestId }
    } catch (reason) {
      if (target.version === getDrawerVersion()) error.textContent = reason.message
      else toast(reason.message, true)
    } finally {
      target.actionBusy = false
      container.querySelectorAll('button').forEach((button) => { button.disabled = false })
      if (target.version === getDrawerVersion()) void refreshOpenRunDrawer()
    }
  }
  container.querySelector('[data-run-respond]').onclick = () => { void submit(false) }
  container.querySelector('[data-run-decline]').onclick = () => { void submit(true) }
}
