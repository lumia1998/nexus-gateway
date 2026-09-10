// @ts-check
import { state } from './state.js'
import { api } from './api.js'
import { toast } from './toast.js'

/** @typedef {import('./contracts.js').Resource} Resource */
/** @typedef {import('./contracts.js').ResourcePayloads} Payloads */
/** @type {Map<string, Promise<unknown>>} */
const pending = new Map()
/** @type {Map<Resource, string>} */
const failures = new Map()
/** @type {Map<Resource, number>} */
const resourceVersions = new Map()
const resourceLabels = {
  config: '配置',
  apiKeys: 'API 密钥',
  overview: '智能体探测',
  runs: '运行记录',
  metrics: '运行指标'
}
let generation = 0

/** @param {Resource} resource */
export function markResourceSaved(resource) {
  resourceVersions.set(resource, (resourceVersions.get(resource) || 0) + 1)
  const path = '/v1/admin/' + (resource === 'apiKeys' ? 'api-keys' : resource)
  // A later retry must not coalesce with a read made before this write.
  for (const pendingPath of pending.keys()) {
    if (pendingPath.split('?')[0] === path) pending.delete(pendingPath)
  }
  markResource(resource, 'ready')
}

export function resetData() {
  generation++
  pending.clear()
  failures.clear()
  state.config = { workspaceRoots: [], driverKinds: [], agents: [] }
  state.apiKeys = []
  state.readiness = []
  state.runs = []
  state.metrics = null
  state.runTotal = state.sessions = state.runOffset = 0
  state.runStats = { active: 0, completed: 0, failed: 0 }
  state.artifacts = []
  state.artifactTotal = state.artifactOffset = 0
  state.artifactAgent = state.artifactKind = 'all'
  state.runHasNew = false
  state.search = state.runSearch = ''
  state.protocol = state.status = state.runAgent = state.runStatus = 'all'
  for (const resource of Object.values(state.resources)) {
    resource.status = 'idle'
    resource.lastSuccessAt = 0
  }
  connectionStatus()
}

/** @param {string} path @returns {Promise<unknown>} */
function read(path) {
  const existing = pending.get(path)
  if (existing) return existing
  const promise = api(path).finally(() => { if (pending.get(path) === promise) pending.delete(path) })
  pending.set(path, promise)
  return promise
}

/** @param {Resource} resource */
function resourceState(resource) {
  return state.resources[resource] || (state.resources[resource] = { status: 'idle', lastSuccessAt: 0 })
}

/** @param {Resource} [resource] */
function renderApp(resource) {
  return import('./render.js').then(({ render }) => {
    const pages = {
      config: ['overview', 'agents', 'workspaces', 'keys', 'settings', 'runs'],
      apiKeys: ['keys'],
      overview: ['overview', 'agents'],
      runs: ['runs'],
      metrics: ['overview']
    }
    if (state.authenticated && (!resource || pages[resource]?.includes(state.page))) render()
  }).catch(() => {})
}

function connectionStatus() {
  const element = document.getElementById('connection-status')
  if (!element) return
  element.replaceChildren()
  if (!failures.size) {
    element.classList.add('hidden')
    return
  }
  element.classList.remove('hidden')
  const entries = [...failures]
  entries.forEach(([resource, message], index) => {
    if (index) element.append(document.createTextNode('；'))
    const line = document.createElement('span')
    const previous = resourceState(resource).lastSuccessAt
    line.textContent = resourceLabels[resource] + '刷新失败，当前为旧数据：' + message +
      (previous ? '（上次成功：' + new Date(previous).toLocaleString() + '）' : '（尚未成功读取）')
    element.append(line)
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'button small connection-retry'
    retry.dataset.resourceRetry = resource
    retry.textContent = '重试'
    retry.onclick = () => { void retryResource(resource) }
    element.append(retry)
  })
}

/** @param {Resource} resource @param {import('./contracts.js').ResourceState['status']} status @param {Error} [error] */
function markResource(resource, status, error) {
  const current = resourceState(resource)
  current.status = status
  if (status === 'ready') {
    current.lastSuccessAt = Date.now()
    failures.delete(resource)
  } else if (error) {
    failures.set(resource, error.message)
  }
  connectionStatus()
}

export function runsPath() {
  const query = new URLSearchParams({ limit: String(state.runPageSize || 50) })
  if (state.runSearch.trim()) query.set('q', state.runSearch.trim())
  if (state.runAgent !== 'all') query.set('agentId', state.runAgent)
  if (state.runStatus !== 'all') query.set('state', state.runStatus)
  if (state.runOffset) query.set('offset', String(state.runOffset))
  return '/v1/admin/runs?' + query
}

/** @param {import('./contracts.js').RunListPayload} value */
function acceptRuns(value) {
  state.runHasNew = false
  state.runs = value.runs || []
  state.runTotal = value.total || 0
  state.runStats = value.stats || { active: 0, completed: 0, failed: 0 }
}

/** @param {number} revision @param {number} epoch */
function isCurrent(revision, epoch) {
  return revision === generation && epoch === state.authEpoch
}

/**
 * @template {Resource} K
 * @param {K} resource
 * @param {string} path
 * @param {number} revision
 * @param {number} epoch
 * @param {(value: Payloads[K]) => void} accept
 */
async function loadResource(resource, path, revision, epoch, accept) {
  const version = resourceVersions.get(resource) || 0
  const current = () => isCurrent(revision, epoch) && version === (resourceVersions.get(resource) || 0)
  markResource(resource, 'loading')
  try {
    const value = /** @type {Payloads[K]} */ (await read(path))
    if (!current()) return value
    accept(value)
    markResource(resource, 'ready')
    void renderApp(resource)
    return value
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (current()) {
      markResource(resource, 'error', error)
      void renderApp(resource)
    }
    return undefined
  }
}

/** @param {boolean} [force] */
export async function loadAll(force) {
  const revision = ++generation
  const epoch = state.authEpoch
  pending.clear()
  const path = runsPath()
  const suffix = force ? '?refresh=1' : ''
  // Each request settles independently. In particular, overview runs probes
  // that can take considerably longer than config and history reads.
  const tasks = [
    loadResource('config', '/v1/admin/config', revision, epoch, (value) => { state.config = value }),
    loadResource('apiKeys', '/v1/admin/api-keys', revision, epoch, (value) => { state.apiKeys = value.apiKeys || [] }),
    loadResource('overview', '/v1/admin/overview' + suffix, revision, epoch, (value) => {
      state.readiness = value.agents || []
      state.sessions = value.sessions || 0
    }),
    loadResource('metrics', '/v1/admin/metrics', revision, epoch, (value) => { state.metrics = value }),
    loadResource('runs', path, revision, epoch, (value) => {
      if (path === runsPath()) acceptRuns(value)
    })
  ]
  return Promise.all(tasks)
}

/** @param {Resource} resource */
export async function retryResource(resource) {
  // Keep the global generation unchanged: retrying one slow resource must not
  // invalidate unrelated config, key, or history requests already in flight.
  const revision = generation
  const epoch = state.authEpoch
  if (resource === 'config') return loadResource('config', '/v1/admin/config', revision, epoch, (value) => { state.config = value })
  if (resource === 'apiKeys') return loadResource('apiKeys', '/v1/admin/api-keys', revision, epoch, (value) => { state.apiKeys = value.apiKeys || [] })
  if (resource === 'overview') return loadResource('overview', '/v1/admin/overview?refresh=1', revision, epoch, (value) => { state.readiness = value.agents || []; state.sessions = value.sessions || 0 })
  if (resource === 'metrics') return loadResource('metrics', '/v1/admin/metrics', revision, epoch, (value) => { state.metrics = value })
  const path = runsPath()
  return loadResource('runs', path, revision, epoch, (value) => { if (path === runsPath()) acceptRuns(value) })
}

/** @param {boolean} [showNotice] */
export async function refreshRuns(showNotice) {
  const { renderRuns, refreshOpenRunDrawer } = await import('./render.js')
  void refreshOpenRunDrawer()
  const path = runsPath()
  const revision = generation
  const epoch = state.authEpoch
  try {
    const value = /** @type {import('./contracts.js').RunListPayload} */ (await read(path))
    if (path !== runsPath() || !isCurrent(revision, epoch)) return
    if (!showNotice && state.runOffset > 0 && state.runs.length && value.total > state.runTotal) {
      state.runHasNew = true
      markResource('runs', 'ready')
      if (state.page === 'runs') renderRuns()
      return
    }
    acceptRuns(value)
    markResource('runs', 'ready')
    if (state.page === 'runs') renderRuns()
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (path !== runsPath() || !isCurrent(revision, epoch)) return
    markResource('runs', 'error', error)
    if (showNotice) toast(error.message, true)
  }
}

/** @param {boolean} [showNotice] */
export async function refreshReadiness(showNotice) {
  const { render } = await import('./render.js')
  const revision = generation
  const epoch = state.authEpoch
  try {
    const overview = /** @type {import('./contracts.js').OverviewPayload} */ (await read('/v1/admin/overview?refresh=1'))
    if (!isCurrent(revision, epoch)) return
    state.readiness = overview.agents || []
    state.sessions = overview.sessions || 0
    markResource('overview', 'ready')
    if (state.page === 'overview' || state.page === 'agents') render()
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    if (!isCurrent(revision, epoch)) return
    markResource('overview', 'error', error)
    if (showNotice) toast(error.message, true)
  }
}
