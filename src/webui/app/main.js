import { state } from './state.js'
import { byId, content, drawerForm, drawerFooter, drawerBackdrop, keyActionMenu } from './dom.js'
import { api } from './api.js'
import { toast, runAction, withBusy } from './toast.js'
import { boot, enterApp, showLogin } from './screens.js'
import { applyTheme } from './theme.js'
import { loadAll, refreshRuns, refreshReadiness } from './data.js'
import { closeDrawer, getDrawerSubmit, getDrawerVersion, openConfirmDrawer, handleDrawerKeydown } from './drawer.js'
import {
  render,
  openRunDrawer,
  openAgentDrawer,
  openWorkspaceDrawer,
  workspaceDependents,
  openKeyDrawer,
  openKeyScopeDrawer,
  openRenameKeyDrawer,
  showSecret,
  copySecret,
  reloadKeys,
  toggleKeyActionMenu,
  handleKeyMenuKeydown,
  closeKeyActionMenu
} from './render.js'

function handleKeyAction(action, id) {
  const key = state.apiKeys.find((item) => item.id === id)
  if (!key) return
  if (action === 'rename') {
    openRenameKeyDrawer(key)
    return
  }
  if (action === 'regenerate') {
    openConfirmDrawer('重新生成 API 密钥', '当前密钥会立即失效，使用它的客户端必须改用新密钥。', '重新生成', async (isCurrent) => {
      const value = await api('/v1/admin/api-keys/' + encodeURIComponent(id) + '/regenerate', { method: 'POST' })
      await reloadKeys()
      if (isCurrent()) showSecret('API 密钥已重新生成', value.secret)
      else toast('API 密钥已重新生成，可在密钥列表中显示或复制')
    })
    return
  }
  if (action === 'delete') {
    openConfirmDrawer('删除 API 密钥', '使用该密钥的客户端会立即失去访问权限，此操作无法撤销。', '删除密钥', async () => {
      await api('/v1/admin/api-keys/' + encodeURIComponent(id), { method: 'DELETE' })
      await reloadKeys()
      toast('API 密钥已删除')
    })
    return
  }
  void runAction(async () => {
    if (action === 'copy') {
      const value = await api('/v1/admin/api-keys/' + encodeURIComponent(id) + '/reveal', { method: 'POST' })
      await copySecret(value.secret)
      toast('API 密钥已复制')
    }
    if (action === 'reveal') {
      const value = await api('/v1/admin/api-keys/' + encodeURIComponent(id) + '/reveal', { method: 'POST' })
      showSecret('显示 API 密钥', value.secret)
    }
    if (action === 'scope') openKeyScopeDrawer(key)
    if (action === 'toggle') {
      await api('/v1/admin/api-keys/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: !key.enabled } })
      await reloadKeys()
      toast(key.enabled ? 'API 密钥已禁用' : 'API 密钥已启用')
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
  if (button.dataset.emptyAction) {
    if (button.dataset.emptyAction === 'add-agent') openAgentDrawer()
    if (button.dataset.emptyAction === 'create-key') openKeyDrawer()
    if (button.dataset.emptyAction === 'add-workspace') openWorkspaceDrawer()
    return
  }
  if (button.dataset.keyMenu) {
    toggleKeyActionMenu(button, button.dataset.keyMenu)
    return
  }
  if (button.dataset.agentEdit) {
    openAgentDrawer(state.config.agents.find((agent) => agent.id === button.dataset.agentEdit))
    return
  }
  if (button.dataset.agentDelete) {
    const id = button.dataset.agentDelete
    openConfirmDrawer('删除智能体', '删除后该智能体不再接受新任务，已有会话不受影响。', '删除智能体', async () => {
      state.config = await api('/v1/admin/agents/' + encodeURIComponent(id), { method: 'DELETE' })
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
    const root = (state.config.workspaceRoots || [])[index] || ''
    if (workspaceDependents(index).length) {
      toast('请先修改使用此工作区的智能体配置', true)
      return
    }
    openConfirmDrawer('删除工作区', '删除后，新会话将无法再使用 ' + root + '；目录中的文件不会被删除。', '删除工作区', async () => {
      const roots = state.config.workspaceRoots.filter((_, itemIndex) => itemIndex !== index)
      state.config = await api('/v1/admin/config/workspace-roots', { method: 'PUT', body: { workspaceRoots: roots } })
      render()
      toast('工作区已删除')
    })
    return
  }
  if (button.dataset.keyAction) handleKeyAction(button.dataset.keyAction, button.dataset.keyId)
}

/* ── Auth forms ───────────────────────────────────────────────────── */

byId('setup-form').onsubmit = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  await withBusy(event.submitter || form.querySelector('[type="submit"]'), async () => {
    const error = form.querySelector('[data-form-error]')
    error.textContent = ''
    const data = new FormData(form)
    try {
      await api('/v1/bootstrap/initialize', { method: 'POST', body: { password: String(data.get('password') || ''), confirmPassword: String(data.get('confirmPassword') || '') } })
      form.reset()
      showLogin()
      toast('初始化完成，请使用控制台密码登录。')
    } catch (reason) { error.textContent = reason.message }
  })
}

byId('login-form').onsubmit = async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  await withBusy(event.submitter || form.querySelector('[type="submit"]'), async () => {
    const error = form.querySelector('[data-form-error]')
    error.textContent = ''
    try {
      const data = new FormData(form)
      await api('/v1/admin/auth/login', { method: 'POST', body: { password: String(data.get('password') || '') } })
      form.reset()
      await enterApp()
    } catch (reason) { error.textContent = reason.message }
  })
}

/* ── Navigation ───────────────────────────────────────────────────── */

document.querySelectorAll('.nav-item').forEach((item) => {
  item.onclick = () => {
    if (item.dataset.action === 'logout') {
      void runAction(async () => {
        await api('/v1/admin/auth/logout', { method: 'POST' })
        showLogin()
      })
      return
    }
    state.page = item.dataset.page
    render()
    if (state.page === 'runs') void refreshRuns(false)
  }
})

/* ── Global click delegation ──────────────────────────────────────── */

content.addEventListener('click', (event) => { void handleContentClick(event) })
content.addEventListener('keydown', (event) => {
  const anchor = event.target.closest('[data-key-menu]')
  if (!anchor || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  toggleKeyActionMenu(anchor, anchor.dataset.keyMenu)
  if (event.key === 'ArrowUp') handleKeyMenuKeydown({ key: 'End', preventDefault() {} })
})
keyActionMenu.addEventListener('keydown', handleKeyMenuKeydown)

keyActionMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-key-action]')
  if (!button) return
  closeKeyActionMenu(true)
  void handleKeyAction(button.dataset.keyAction, button.dataset.keyId)
})

/* ── Drawer events ────────────────────────────────────────────────── */

drawerForm.onsubmit = async (event) => {
  event.preventDefault()
  const submit = getDrawerSubmit()
  if (!submit) return
  const version = getDrawerVersion()
  await withBusy(drawerFooter.querySelector('[type="submit"]'), async () => {
    const error = drawerForm.querySelector('[data-form-error]')
    error.textContent = ''
    try { await submit(drawerForm) } catch (reason) {
      if (version === getDrawerVersion()) {
        error.textContent = reason.message
        error.scrollIntoView({ block: 'nearest' })
      }
      else toast(reason.message, true)
    }
  })
}
drawerForm.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-drawer]')) closeDrawer()
})
drawerFooter.addEventListener('click', (event) => {
  if (event.target.closest('[data-close-drawer]')) closeDrawer()
})
byId('drawer-close').onclick = closeDrawer
drawerBackdrop.onclick = closeDrawer

/* ── Global listeners ─────────────────────────────────────────────── */

document.addEventListener('click', (event) => {
  if (!event.target.closest('.key-action-menu') && !event.target.closest('[data-key-menu]')) closeKeyActionMenu()
})
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ((localStorage.getItem('agent-nexus-theme') || 'system') === 'system') applyTheme('system')
})
document.addEventListener('keydown', (event) => {
  if (event.isComposing) return
  handleDrawerKeydown(event)
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
