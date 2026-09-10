import { state } from './state.js'
import { byId, content, drawerForm, drawerFooter, drawerBackdrop, keyActionMenu } from './dom.js'
import { api } from './api.js'
import { toast, runAction, withBusy } from './toast.js'
import { boot, enterApp, showLogin } from './screens.js'
import { applyTheme } from './theme.js'
import { readLocationState, writeLocationState } from './location-state.js'
import { loadAll, refreshRuns, refreshReadiness, markResourceSaved, retryResource } from './data.js'
import { closeDrawer, getDrawerSubmit, getDrawerVersion, openConfirmDrawer, handleDrawerKeydown } from './drawer.js'
import {
  render,
  openRunDrawer,
  refreshOpenRunDrawer,
  openAgentDrawer,
  openAgentDiagnostics,
  openWorkspaceDrawer,
  workspaceDependents,
  openKeyDrawer,
  openKeyScopeDrawer,
  openRenameKeyDrawer,
  showSecret,
  copySecret,
  applyApiKey,
  toggleKeyActionMenu,
  handleKeyMenuKeydown,
  closeKeyActionMenu,
  openArtifactDetail,
  confirmArtifactDelete,
  loadArtifacts
} from './render.js'

function handleKeyAction(action, id) {
  const key = state.apiKeys.find((item) => item.id === id)
  if (!key) return
  if (action === 'rename') {
    openRenameKeyDrawer(key)
    return
  }
  if (action === 'regenerate') {
    openConfirmDrawer('重新生成 API 密钥', '旧密钥会立即拒绝新请求，并关闭使用它的现有 SSE 连接；正在执行的任务会继续。原密钥 ID 和会话归属保留，客户端需改用新密钥。', '重新生成', async (isCurrent) => {
      const value = await api('/v1/admin/api-keys/' + encodeURIComponent(id) + '/regenerate', { method: 'POST' })
      applyApiKey(value.key)
      if (isCurrent()) showSecret('API 密钥已重新生成', value.secret)
      else toast('API 密钥已重新生成，可在密钥列表中显示或复制')
    })
    return
  }
  if (action === 'delete') {
    openConfirmDrawer('删除 API 密钥', '会立即拒绝使用该密钥的新请求，并关闭使用它的现有 SSE 连接；正在执行的任务会继续。删除后，原密钥 ID 的已有会话无法再访问。此操作无法撤销。', '删除密钥', async () => {
      await api('/v1/admin/api-keys/' + encodeURIComponent(id), { method: 'DELETE' })
      state.apiKeys = state.apiKeys.filter((item) => item.id !== id)
      markResourceSaved('apiKeys')
      render()
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
      const apply = async () => {
        const updated = await api('/v1/admin/api-keys/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: !key.enabled } })
        applyApiKey(updated)
        toast(key.enabled ? 'API 密钥已禁用；现有 SSE 已关闭，正在执行的任务会继续' : 'API 密钥已启用')
      }
      if (key.enabled) {
        openConfirmDrawer('禁用 API 密钥', '禁用会立即拒绝新请求，并关闭使用它的现有 SSE 连接；正在执行的任务会继续。已有会话在密钥重新启用后仍按原会话归属处理。', '禁用密钥', async () => { await apply() })
      } else await apply()
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
  if (button.dataset.runQuickCancel) {
    const id = button.dataset.runQuickCancel
    openConfirmDrawer('取消任务', '取消当前任务并释放智能体会话。已经完成的文件或外部操作不会撤回。', '取消任务', async () => {
      await api('/v1/admin/runs/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} })
      toast('任务已取消')
      void retryResource('metrics')
    })
    return
  }
  if (button.dataset.runQuickDelete) {
    const id = button.dataset.runQuickDelete
    openConfirmDrawer('删除运行记录', '仅删除这条历史记录与已保存的产物文件，不影响智能体配置和客户端会话。此操作无法撤销。', '删除记录', async () => {
      await api('/v1/admin/runs/' + encodeURIComponent(id), { method: 'DELETE', body: {} })
      toast('运行记录已删除')
      void retryResource('metrics')
    })
    return
  }
  if (button.dataset.artifactDetail) {
    openArtifactDetail(button.dataset.artifactDetail, button.dataset.artifactRun)
    return
  }
  if (button.dataset.artifactDelete) {
    confirmArtifactDelete(button.dataset.artifactDelete, button.dataset.artifactRun)
    return
  }
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
  if (button.dataset.agentDiagnostics) { await openAgentDiagnostics(button.dataset.agentDiagnostics); return }
  if (button.dataset.agentDelete) {
    const id = button.dataset.agentDelete
    openConfirmDrawer('删除智能体', '删除后该智能体不再接受新任务，已有会话不受影响。', '删除智能体', async () => {
      state.config = await api('/v1/admin/agents/' + encodeURIComponent(id), { method: 'DELETE' })
      render()
      toast('智能体已删除')
      void loadAll(true)
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
      markResourceSaved('config')
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
      await api('/v1/bootstrap/initialize', { method: 'POST', body: { setupToken: String(data.get('setupToken') || '').trim(), password: String(data.get('password') || ''), confirmPassword: String(data.get('confirmPassword') || '') } })
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
    writeLocationState(state)
    render()
    if (state.page === 'runs') void refreshRuns(false)
    if (state.page === 'overview') void retryResource('metrics')
    if (state.page === 'artifacts') void loadArtifacts(false)
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
window.addEventListener('hashchange', () => {
  Object.assign(state, readLocationState())
  if (!state.authenticated) return
  render()
  if (state.page === 'runs') void refreshRuns(true)
  if (state.page === 'artifacts') void loadArtifacts(false)
  if (state.selectedRunId) void openRunDrawer(state.selectedRunId)
})

/* ── Pollers ──────────────────────────────────────────────────────── */

setInterval(() => {
  if (state.authenticated && !document.hidden && ['overview', 'agents'].includes(state.page)) void refreshReadiness(false)
}, 20_000)

setInterval(() => {
  if (state.authenticated && !document.hidden && state.page === 'runs') void refreshRuns(false)
}, 5_000)

setInterval(() => {
  if (state.authenticated && !document.hidden) void refreshOpenRunDrawer()
  if (state.authenticated && !document.hidden && state.page === 'overview') void retryResource('metrics')
}, 5_000)

void boot()
