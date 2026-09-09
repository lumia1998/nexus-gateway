import { state } from './state.js'
import { setupScreen, loginScreen, appRoot, byId } from './dom.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { loadAll, resetData } from './data.js'
import { render, resetView, openRunDrawer } from './render.js'
import { readLocationState } from './location-state.js'
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
  state.authEpoch++
  closeDrawer()
  resetData()
  resetView()
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
      byId('setup-token').focus()
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
  const epoch = state.authEpoch
  // Authentication is the gate for the shell. Agent probes and history reads
  // are deliberately started after the shell is visible so a slow/unreachable
  // remote agent cannot send an administrator back to the login screen.
  state.authenticated = true
  Object.assign(state, readLocationState())
  showOnly(appRoot)
  render()
  if (state.selectedRunId) void openRunDrawer(state.selectedRunId)
  if (epoch !== state.authEpoch) return
  void loadAll().catch((error) => {
    // Individual resources already keep their last good value and expose a
    // retry affordance. This catch is only a guard for an unexpected loader
    // failure and must not turn a valid admin session into a login prompt.
    if (epoch === state.authEpoch) toast(error.message, true)
  })
}
