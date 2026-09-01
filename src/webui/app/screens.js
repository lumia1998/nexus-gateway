import { state } from './state.js'
import { setupScreen, loginScreen, appRoot, byId } from './dom.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { loadAll } from './data.js'
import { render } from './render.js'
import { applyTheme } from './theme.js'

function showOnly(element) {
  setupScreen.classList.add('hidden')
  loginScreen.classList.add('hidden')
  appRoot.classList.add('hidden')
  element.classList.remove('hidden')
}

export function showLogin() {
  state.authenticated = false
  showOnly(loginScreen)
  byId('login-form').reset()
}

export async function boot() {
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

export async function enterApp() {
  state.authenticated = true
  showOnly(appRoot)
  await loadAll()
  render()
}

