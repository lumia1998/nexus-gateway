import { state } from './state.js'
import { byId, content, drawerForm, drawerFooter, drawerBackdrop, keyActionMenu } from './dom.js'
import { api } from './api.js'
import { toast, runAction } from './toast.js'
import { boot, enterApp, showLogin } from './screens.js'
import { applyTheme } from './theme.js'
import { loadAll, refreshRuns, refreshReadiness } from './data.js'
import { closeDrawer, getDrawerSubmit } from './drawer.js'
import {
  render,
  openRunDrawer,
  openAgentDrawer,
  openWorkspaceDrawer,
  openPasswordDrawer,
  openKeyScopeDrawer,
  showSecret,
  copySecret,
  reloadKeys,
  toggleKeyActionMenu,
  closeKeyActionMenu
} from './render.js'

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

/* ── Auth forms ───────────────────────────────────────────────────── */

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

/* ── Navigation ───────────────────────────────────────────────────── */

document.querySelectorAll('.nav-item').forEach((item) => {
  item.onclick = () => {
    state.page = item.dataset.page
    render()
    if (state.page === 'runs') void refreshRuns(false)
  }
})

/* ── Global click delegation ──────────────────────────────────────── */

content.addEventListener('click', (event) => { void handleContentClick(event) })

keyActionMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-key-action]')
  if (!button) return
  closeKeyActionMenu()
  void handleKeyAction(button.dataset.keyAction, button.dataset.keyId)
})

/* ── Drawer events ────────────────────────────────────────────────── */

drawerForm.onsubmit = async (event) => {
  event.preventDefault()
  const submit = getDrawerSubmit()
  if (!submit) return
  const error = drawerForm.querySelector('[data-form-error]')
  error.textContent = ''
  try { await submit(drawerForm) } catch (reason) { error.textContent = reason.message }
}
drawerForm.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-drawer]')) closeDrawer()
})
drawerFooter.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-drawer]')) closeDrawer()
})
byId('drawer-close').onclick = closeDrawer
drawerBackdrop.onclick = closeDrawer

/* ── Admin menu ───────────────────────────────────────────────────── */

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

/* ── Global listeners ─────────────────────────────────────────────── */

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

/* ── Pollers ──────────────────────────────────────────────────────── */

setInterval(() => {
  if (state.authenticated) void refreshReadiness(false)
}, 20_000)

setInterval(() => {
  if (state.authenticated && state.page === 'runs') void refreshRuns(false)
}, 5_000)

void boot()

