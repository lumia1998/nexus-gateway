import { state } from './state.js'
import { api } from './api.js'
import { toast } from './toast.js'

export async function loadAll(force) {
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

export async function refreshRuns(showNotice) {
  const { renderRuns } = await import('./render.js')
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

export async function refreshReadiness(showNotice) {
  const { render } = await import('./render.js')
  try {
    const overview = await api('/v1/admin/overview?refresh=1')
    state.readiness = overview.agents || []
    state.sessions = overview.sessions || 0
    if (state.page === 'overview' || state.page === 'agents') render()
    if (showNotice) toast('运行状态已刷新')
  } catch (error) {
    if (showNotice) toast(error.message, true)
  }
}

