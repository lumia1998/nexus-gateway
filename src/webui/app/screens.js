import { state } from './state.js'
import { setupScreen, loginScreen, appRoot, byId } from './dom.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { loadAll } from './data.js'
import { render } from './render.js'
import { applyTheme } from './theme.js'
import { closeDrawer } from './drawer.js'

function showOnly(element) {
  byId('boot-screen').classList.add('hidden')
  setupScreen.classList.add('hidden')
  loginScreen.classList.add('hidden')
  appRoot.classList.add('hidden')
  element.classList.remove('hidden')
}

export function showLogin() {
  state.authenticated = false
  closeDrawer()
  showOnly(loginScreen)
  byId('login-form').reset()
  byId('login-password').focus()
}

export async function boot() {
  applyTheme(localStorage.getItem('agent-nexus-theme') || 'system')
  try {
    const bootstrap = await api('/v1/bootstrap/status')
    if (bootstrap.adminSetupRequired) {
      showOnly(setupScreen)
      byId('setup-password').focus()
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
  showOnly(byId('boot-screen'))
  try {
    await loadAll()
    state.authenticated = true
    showOnly(appRoot)
    render()
  } catch (error) {
    showLogin()
    throw error
  }
}
