// Page dispatch; rendering and write state live with each page.
import { state, pageMeta } from './state.js'
import { byId, pageStats } from './dom.js'
import { setToolbar, resetSharedView } from './render-shared.js'
import { renderOverview } from './render-overview.js'
import { renderRuns, resetRunView } from './render-runs.js'
import { renderAgents } from './render-agents.js'
import { renderWorkspaces } from './render-workspaces.js'
import { renderApiKeys, closeKeyActionMenu } from './render-keys.js'
import { renderSettings } from './render-settings.js'
import { renderArtifacts } from './render-artifacts.js'
export * from './render-runs.js'
export * from './render-agents.js'
export * from './render-workspaces.js'
export * from './render-keys.js'
export * from './render-artifacts.js'
export function resetView() {
 resetRunView()
 closeKeyActionMenu()
 resetSharedView()
}

export function render() {
  byId('page-title').textContent = pageMeta[state.page]
  byId('page-content').closest('.main')?.classList.toggle('settings-page', state.page === 'settings')
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.page === state.page)
    if (item.dataset.page === state.page) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  })
  if (state.page !== 'runs') pageStats.innerHTML = ''
  if (state.page !== 'runs' && state.page !== 'agents') setToolbar('')
  if (state.page === 'overview') renderOverview()
  if (state.page === 'runs') renderRuns()
  if (state.page === 'artifacts') renderArtifacts()
  if (state.page === 'agents') renderAgents()
  if (state.page === 'workspaces') renderWorkspaces()
  if (state.page === 'keys') renderApiKeys()
  if (state.page === 'settings') renderSettings()
}
