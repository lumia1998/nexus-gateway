import { state } from './state.js'
import { byId, drawerForm, escapeHtml, selected } from './dom.js'
import { icons } from './icons.js'
import { api } from './api.js'
import { withBusy, toast } from './toast.js'
import { openDrawer, openConfirmDrawer } from './drawer.js'
import { copySecret } from './render-keys.js'

import { formatDate, formatSize, kindLabel, shortId } from './format.js'

import { setResults, setActions, setToolbar, announce, emptyState } from './render-shared.js'

const KINDS = ['image', 'video', 'audio', 'file']

const CODE_EXTS = new Set(['js','mjs','cjs','ts','tsx','jsx','py','rb','go','rs','java','c','h','cpp','css','scss','html','htm','sql','sh','bash','ps1','yaml','yml','xml','toml','ini','json'])
const TEXT_EXTS = new Set(['txt','md','markdown','log','csv','tsv','conf','env','gitignore','dockerfile','json','yaml','yml','xml','toml','ini','sh','bash','ps1','js','mjs','cjs','ts','tsx','jsx','py','rb','go','rs','java','c','h','cpp','css','scss','html','htm','sql'])

function artifactName(row) {
  return (row.filename || row.name || row.id).toLowerCase()
}

function isCodeArtifact(row) {
  const mt = (row.mediaType || '').toLowerCase()
  if (mt === 'application/json' || mt === 'application/xml' || mt.endsWith('+json') || mt.endsWith('+xml')) return true
  const ext = artifactName(row).split('.').pop() || ''
  return CODE_EXTS.has(ext)
}

function isTextArtifact(row) {
  const mt = (row.mediaType || '').toLowerCase()
  if (mt.startsWith('text/')) return true
  if (mt === 'application/json' || mt === 'application/xml' || mt.endsWith('+json') || mt.endsWith('+xml')) return true
  const ext = artifactName(row).split('.').pop() || ''
  return TEXT_EXTS.has(ext)
}

function artifactUrl(row) {
  return '/v1/admin/runs/' + encodeURIComponent(row.runId) + '/artifacts/' + encodeURIComponent(row.id)
}

export function findArtifact(artifactId, runId) {
  return state.artifacts.find((row) => row.id === artifactId && row.runId === runId)
}

function previewIcon(row) {
  if (row.kind === 'image') return icons.image
  if (row.kind === 'video') return icons.filePlay
  if (row.kind === 'audio') return icons.fileAudio
  if (isCodeArtifact(row)) return icons.fileCode
  if (isTextArtifact(row)) return icons.fileText
  return icons.file
}

function previewCell(row) {
  return '<button type="button" class="artifact-tile" aria-label="查看产物详情" data-artifact-detail="' + escapeHtml(row.id) + '" data-artifact-run="' + escapeHtml(row.runId) + '">' + previewIcon(row) + '</button>'
}

function artifactRow(row) {
  const title = row.name || row.filename || row.id
  return '<tr><td>' + previewCell(row) + '</td><td><div class="agent-name"><strong>' + escapeHtml(title) + '</strong>' +
    (row.filename && row.filename !== title ? '<small>' + escapeHtml(row.filename) + '</small>' : '') +
    (row.mediaType ? '<small>' + escapeHtml(row.mediaType) + '</small>' : '') + '</div></td>' +
    '<td><div class="agent-name"><strong>' + escapeHtml(row.agentName) + '</strong><small>' + escapeHtml(shortId(row.runId)) + '</small></div></td>' +
    '<td class="num">' + escapeHtml(formatSize(row.size)) + '</td>' +
    '<td class="num">' + escapeHtml(formatDate(row.createdAt || row.runStartedAt)) + '</td>' +
    '<td><div class="row-actions">' +
    (row.downloadable ? '<a class="button small" download href="' + artifactUrl(row) + '">下载</a>' : '<span class="muted">' + escapeHtml(row.storageStatus === 'metadata_only' ? '仅元数据' : '不可下载') + '</span>') +
    '<button type="button" class="button small danger" data-artifact-delete="' + escapeHtml(row.id) + '" data-artifact-run="' + escapeHtml(row.runId) + '">删除</button>' +
    '</div></td></tr>'
}

function artifactsPath() {
  const query = new URLSearchParams({ limit: '50' })
  if (state.artifactOffset) query.set('offset', String(state.artifactOffset))
  if (state.artifactAgent !== 'all') query.set('agentId', state.artifactAgent)
  if (state.artifactKind !== 'all') query.set('kind', state.artifactKind)
  return '/v1/admin/artifacts?' + query
}

let loadSeq = 0

export async function loadArtifacts(showError) {
  const path = artifactsPath()
  const seq = ++loadSeq
  try {
    const value = /** @type {import('./contracts.js').ArtifactListPayload} */ (await api(path))
    if (seq !== loadSeq) return
    state.artifacts = value.artifacts || []
    state.artifactTotal = value.total || 0
    renderArtifacts()
  } catch (error) {
    if (seq !== loadSeq) return
    if (showError) toast(error.message, true)
  }
}

export function resetArtifactView() { loadSeq++ }

function renderToolbar() {
  const agents = state.config.agents.map((agent) => '<option value="' + escapeHtml(agent.id) + '"' + selected(state.artifactAgent, agent.id) + '>' + escapeHtml(agent.name) + '</option>').join('')
  const kinds = KINDS.map((kind) => '<option value="' + kind + '"' + selected(state.artifactKind, kind) + '>' + escapeHtml(kindLabel(kind)) + '</option>').join('')
  setToolbar('artifacts|' + state.artifactAgent + '|' + state.artifactKind,
    '<div class="toolbar"><select id="artifact-agent-filter" aria-label="按智能体筛选"><option value="all">全部智能体</option>' + agents + '</select>' +
    '<select id="artifact-kind-filter" aria-label="按类型筛选"><option value="all">全部类型</option>' + kinds + '</select>' +
    '<button class="button small" id="clear-artifact-filters"' + ((state.artifactAgent !== 'all' || state.artifactKind !== 'all') ? '' : ' hidden') + '>清除筛选</button></div>')
  byId('artifact-agent-filter').onchange = (event) => { state.artifactAgent = event.target.value; state.artifactOffset = 0; void loadArtifacts(false) }
  byId('artifact-kind-filter').onchange = (event) => { state.artifactKind = event.target.value; state.artifactOffset = 0; void loadArtifacts(false) }
  byId('clear-artifact-filters').onclick = () => { state.artifactAgent = 'all'; state.artifactKind = 'all'; state.artifactOffset = 0; void loadArtifacts(false) }
}

export function renderArtifacts() {
  setActions('<button id="refresh-artifacts" class="button">' + icons.refresh + '刷新</button>')
  byId('refresh-artifacts').onclick = (event) => withBusy(event.currentTarget, () => loadArtifacts(true))
  if (!state.config.agents.length && ['idle', 'loading'].includes(state.resources.config.status)) {
    setToolbar('')
    setResults('<div class="panel"><p class="panel-note">正在加载网关配置…</p></div>')
    return
  }
  renderToolbar()
  const total = state.artifactTotal
  const offset = state.artifactOffset
  if (!total) {
    setResults('<div class="panel">' + emptyState(icons.artifacts, '暂无产物', '智能体任务产出的文件、图片、视频会保存在这里，可下载或删除。') + '</div>')
    announce('暂无产物')
    return
  }
  const first = offset + 1
  const last = Math.min(offset + 50, total)
  setResults('<div class="run-pagination"><span class="muted">显示 ' + first + '–' + last + '，共 ' + total + ' 个产物</span><div class="row-actions"><button class="button small" id="artifacts-prev"' + (offset ? '' : ' disabled') + '>上一页</button><button class="button small" id="artifacts-next"' + (offset + 50 < total ? '' : ' disabled') + '>下一页</button></div></div>' +
    '<div class="table-wrap"><table class="artifact-table"><thead><tr><th>预览</th><th>名称</th><th>来源</th><th class="num">大小</th><th class="num">保存时间</th><th>操作</th></tr></thead><tbody>' +
    (state.artifacts.length ? state.artifacts.map(artifactRow).join('') : '<tr><td colspan="6" class="empty">没有符合条件的产物。</td></tr>') +
    '</tbody></table></div>')
  byId('artifacts-prev').onclick = (event) => withBusy(event.currentTarget, async () => { state.artifactOffset = Math.max(0, state.artifactOffset - 50); await loadArtifacts(true) })
  byId('artifacts-next').onclick = (event) => withBusy(event.currentTarget, async () => { state.artifactOffset += 50; await loadArtifacts(true) })
  announce(total + ' 个产物')
}

const TEXT_PREVIEW_LIMIT = 512 * 1024
const TEXT_DISPLAY_LIMIT = 64 * 1024

function previewMarkup(row) {
  const url = artifactUrl(row)
  if (row.kind === 'image' && row.downloadable) return '<img class="artifact-preview" src="' + url + '" alt="' + escapeHtml(row.name || row.filename || '产物') + '">'
  if (row.kind === 'video' && row.downloadable) return '<video class="artifact-preview" controls preload="metadata" src="' + url + '"></video>'
  if (row.kind === 'audio' && row.downloadable) return '<audio controls preload="metadata" src="' + url + '"></audio>'
  if (row.kind === 'file' && row.downloadable && isTextArtifact(row)) {
    return '<pre class="run-detail-code artifact-text-preview" data-text-preview>正在加载预览…</pre>'
  }
  return '<p class="field-help">' + (row.downloadable ? '此类型不支持在线预览，可下载后查看。' : '该产物没有可下载的文件内容（' + escapeHtml(row.storageStatus || 'metadata_only') + '）。') + '</p>'
}

function loadTextPreview(row) {
  const preview = drawerForm.querySelector('[data-text-preview]')
  if (!preview) return
  if (row.size != null && row.size > TEXT_PREVIEW_LIMIT) {
    preview.textContent = '文件较大（' + formatSize(row.size) + '），未自动加载预览，可下载后查看。'
    return
  }
  fetch(artifactUrl(row)).then((response) => {
    if (!response.ok) throw new Error('HTTP ' + response.status)
    return response.text()
  }).then((text) => {
    if (!preview.isConnected) return
    preview.textContent = text.length > TEXT_DISPLAY_LIMIT
      ? text.slice(0, TEXT_DISPLAY_LIMIT) + '\n\n…[预览已截断，请下载查看完整内容]'
      : text
  }).catch((error) => {
    if (!preview.isConnected) return
    preview.textContent = '预览加载失败：' + (error instanceof Error ? error.message : String(error))
  })
}

export function openArtifactDetail(artifactId, runId) {
  const row = findArtifact(artifactId, runId)
  if (!row) { toast('产物不存在或已被删除', true); return }
  const title = row.name || row.filename || row.id
  // 以当前访问地址为基准拼出完整文件链接，同源部署（127.0.0.1 / 服务器 IP / 反向代理域名）都自动正确
  const fileUrl = row.downloadable ? new URL(artifactUrl(row), window.location.href).href : ''
  const body =
    '<div class="run-detail-grid">' +
    [['name', '名称'], ['mediaType', '类型'], ['size', '大小'], ['createdAt', '保存时间'], ['agent', '来源智能体'], ['run', '运行 ID']]
      .map(([key, label]) => {
        const value = { name: title, mediaType: row.mediaType || '—', size: formatSize(row.size), createdAt: formatDate(row.createdAt || row.runStartedAt), agent: row.agentName, run: shortId(row.runId) }[key]
        return '<div class="run-detail-item"><span>' + label + '</span><strong>' + escapeHtml(value) + '</strong></div>'
      }).join('') +
    '</div>' +
    (fileUrl ?
      '<div class="artifact-link-row"><span class="muted">文件链接</span><div class="artifact-link-line"><code><a href="' + escapeHtml(fileUrl) + '" target="_blank" rel="noopener">' + escapeHtml(fileUrl) + '</a></code>' +
      '<button type="button" class="button small" data-artifact-copy-link>' + icons.copy + '复制</button></div></div>' : '') +
    '<div class="artifact-preview-wrap">' + previewMarkup(row) + '</div>' +
    '<div class="run-detail-actions">' +
    (row.downloadable ? '<a class="button small" download href="' + artifactUrl(row) + '">下载</a>' : '') +
    '<button type="button" class="button small danger" data-artifact-delete="' + escapeHtml(row.id) + '" data-artifact-run="' + escapeHtml(row.runId) + '">删除产物</button>' +
    '</div>'
  openDrawer('产物详情', body, '', null)
  const remove = drawerForm.querySelector('[data-artifact-delete]')
  if (remove) remove.onclick = () => confirmArtifactDelete(remove.dataset.artifactDelete, remove.dataset.artifactRun)
  const copyLink = drawerForm.querySelector('[data-artifact-copy-link]')
  if (copyLink) copyLink.onclick = () => withBusy(copyLink, async () => { await copySecret(fileUrl, '请手动复制上方链接'); toast('文件链接已复制') })
  loadTextPreview(row)
}

export function confirmArtifactDelete(artifactId, runId) {
  const row = findArtifact(artifactId, runId)
  const title = row ? (row.name || row.filename || row.id) : artifactId
  openConfirmDrawer('删除产物', '删除「' + title + '」的文件与记录，释放存储空间。运行记录本身保留。此操作无法撤销。', '删除产物', async () => {
    await api('/v1/admin/runs/' + encodeURIComponent(runId) + '/artifacts/' + encodeURIComponent(artifactId), { method: 'DELETE', body: {} })
    toast('产物已删除')
    if (state.page === 'artifacts') void loadArtifacts(false)
  })
}
