import { state } from './state.js'
import { byId, keyActionMenu, escapeHtml, selected, checked } from './dom.js'
import { icons } from './icons.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { openDrawer, closeDrawer } from './drawer.js'
import { showLogin } from './screens.js'

import { markResourceSaved } from './data.js'
import { formatDate } from './format.js'

import { render } from './render.js'
import { setResults, setActions, announce, emptyState } from './render-shared.js'

let menuAnchor = null

export function keyRow(key) {
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

export function renderApiKeys() {
  closeKeyActionMenu()
  setActions('<button id="create-key" class="button primary">' + icons.plus + '创建 API 密钥</button>')
  const pending = state.resources.apiKeys.status === 'loading' && !state.apiKeys.length
  setResults(pending ? '<div class="panel"><p class="panel-note">正在加载 API 密钥…</p></div>' : state.apiKeys.length
    ? '<div class="table-wrap key-table-wrap"><table class="key-table"><thead><tr><th>名称</th><th>状态</th><th>API 密钥</th><th>授权范围</th><th>最后使用</th><th>操作</th></tr></thead><tbody>' + state.apiKeys.map(keyRow).join('') + '</tbody></table></div>'
    : '<div class="panel">' + emptyState(icons.key, '尚未创建 API 密钥', '客户端调用网关数据接口时需要携带密钥。', { action: 'create-key', label: '创建 API 密钥' }) + '</div>')
  byId('create-key').onclick = () => openKeyDrawer()
  byId('create-key').disabled = !state.resources.config.lastSuccessAt || !state.resources.apiKeys.lastSuccessAt
  announce(state.apiKeys.length + ' 个 API 密钥')
}

export function agentScopeOption(agent, selected = false) {
  return '<label class="checkbox"><input type="checkbox" name="agentId" value="' + escapeHtml(agent.id) + '"' + checked(selected) + '><span class="scope-name">' + escapeHtml(agent.name) + '</span><span class="muted">(' + escapeHtml(agent.protocol.toUpperCase()) + ')</span></label>'
}

export function openKeyDrawer() {
  if (!state.resources.config.lastSuccessAt || !state.resources.apiKeys.lastSuccessAt) { toast('配置与密钥列表尚未成功读取，请重试后创建', true); return }
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
    markResourceSaved('apiKeys')
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
  const body = '<p class="field-help">缩小授权范围会立即拒绝受影响的新请求并关闭对应 SSE；正在执行的任务会继续。</p><div class="field"><label class="checkbox"><input id="edit-all-agents" name="allAgents" type="checkbox"' + checked(key.scope.allAgents) + '>允许访问全部智能体</label></div><div id="edit-agent-scope" class="agent-scope' + (key.scope.allAgents ? ' hidden' : '') + '">' + (scopeRows || '<span class="muted">尚未配置智能体。</span>') + '</div>'
  openDrawer('编辑 API 密钥授权范围', body, '保存授权范围', async (form, isCurrent) => {
    const data = new FormData(form)
    const allAgents = data.get('allAgents') === 'on'
    const agentIds = data.getAll('agentId').map(String)
    if (!allAgents && !agentIds.length) throw new Error('请至少选择一个智能体')
    const narrowed = key.scope.allAgents && !allAgents || !key.scope.allAgents && !allAgents && (key.scope.agentIds || []).some((agentId) => !agentIds.includes(agentId))
    const updated = await api('/v1/admin/api-keys/' + encodeURIComponent(key.id), { method: 'PATCH', body: { scope: { allAgents, agentIds } } })
    if (isCurrent()) closeDrawer()
    applyApiKey(updated)
    toast(narrowed ? 'API 密钥授权范围已更新；受影响 SSE 已关闭，正在执行的任务会继续' : 'API 密钥授权范围已更新')
  })
  const all = byId('edit-all-agents')
  all.onchange = () => byId('edit-agent-scope').classList.toggle('hidden', all.checked)
}

export function openRenameKeyDrawer(key) {
  openDrawer('重命名 API 密钥', '<div class="field"><label for="f-key-name">名称</label><input id="f-key-name" name="name" value="' + escapeHtml(key.name) + '" required autocomplete="off"></div>', '保存名称', async (form, isCurrent) => {
    const name = String(new FormData(form).get('name') || '').trim()
    if (name === key.name) { closeDrawer(); return }
    const updated = await api('/v1/admin/api-keys/' + encodeURIComponent(key.id), { method: 'PATCH', body: { name } })
    if (isCurrent()) closeDrawer()
    applyApiKey(updated)
    toast('API 密钥已重命名')
  })
  const input = byId('f-key-name')
  if (input) setTimeout(() => input.select(), 0)
}

export function applyApiKey(key) {
  state.apiKeys = state.apiKeys.map((current) => current.id === key.id ? key : current)
  markResourceSaved('apiKeys')
  render()
}

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
