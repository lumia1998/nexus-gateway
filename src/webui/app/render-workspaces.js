import { state } from './state.js'
import { byId, escapeHtml } from './dom.js'
import { icons } from './icons.js'
import { api } from './api.js'
import { toast } from './toast.js'
import { openDrawer, closeDrawer } from './drawer.js'

import { markResourceSaved } from './data.js'

import { render } from './render.js'
import { setResults, setActions, announce, emptyState } from './render-shared.js'

export function withinRoot(root, workspace) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(root)
  const normalize = (value) => windows ? value.replace(/\\/g, '/').toLowerCase() : value
  const base = normalize(root).replace(/\/+$/, '')
  const candidate = normalize(workspace)
  return candidate === base || candidate.startsWith(base + '/')
}

export function workspaceDependents(index) {
  const roots = state.config.workspaceRoots
  return state.config.agents.filter((agent) => agent.protocol === 'acp' && agent.workspace &&
    withinRoot(roots[index], agent.workspace) &&
    !roots.some((root, other) => other !== index && withinRoot(root, agent.workspace)))
}

export function workspaceRow(root, index, total) {
  const usedBy = state.config.agents.filter((agent) => agent.protocol === 'acp' && agent.workspace && withinRoot(root, agent.workspace)).map((agent) => escapeHtml(agent.name))
  const blocked = workspaceDependents(index).length > 0
  return '<div class="list-row"><div class="list-row-main"><strong class="path">' + escapeHtml(root) + '</strong>' +
    '<small>' + (usedBy.length ? '使用中：' + usedBy.join('、') : '没有智能体使用') + '</small></div>' +
    '<div class="row-actions"><button class="button small" data-workspace-edit="' + index + '">编辑</button>' +
    '<button class="button small danger" data-workspace-delete="' + index + '"' +
    (total === 1 ? ' disabled title="至少保留一个工作区"' : blocked ? ' disabled title="请先修改使用此工作区的智能体配置"' : '') + '>删除</button></div></div>'
}

export function renderWorkspaces() {
  setActions('<button id="add-workspace" class="button primary">' + icons.plus + '添加工作区</button>')
  byId('add-workspace').onclick = () => openWorkspaceDrawer()
  byId('add-workspace').disabled = !state.resources.config.lastSuccessAt
  const roots = state.config.workspaceRoots || []
  const pending = !state.resources.config.lastSuccessAt && ['idle', 'loading'].includes(state.resources.config.status)
  setResults(pending ? '<div class="panel"><p class="panel-note">正在加载工作区配置…</p></div>' : !state.resources.config.lastSuccessAt ? '<div class="panel"><p class="panel-note">工作区配置读取失败，请重试后编辑。</p></div>' : '<div class="panel"><div class="panel-header"><h2>允许的根目录</h2><span class="muted">' + roots.length + ' 个</span></div>' +
    (roots.length
      ? '<div class="panel-body workspace-list">' + roots.map((root, index) => workspaceRow(root, index, roots.length)).join('') + '</div>'
      : emptyState(icons.folder, '尚未配置工作区', '', { action: 'add-workspace', label: '添加工作区' })) +
    '</div>')
  announce(roots.length + ' 个工作区')
}

export function openWorkspaceDrawer(index) {
  if (!state.resources.config.lastSuccessAt) { toast('配置尚未成功读取，请重试后编辑', true); return }
  const editing = Number.isInteger(index)
  const current = editing ? state.config.workspaceRoots[index] : ''
  openDrawer(editing ? '编辑工作区' : '添加工作区', '<div class="field"><label for="f-path">允许访问的根目录</label><input id="f-path" name="path" value="' + escapeHtml(current) + '" required></div>', editing ? '保存修改' : '添加工作区', async (form, isCurrent) => {
    const roots = state.config.workspaceRoots.slice()
    const value = String(new FormData(form).get('path') || '').trim()
    if (editing) roots[index] = value
    else roots.push(value)
    const result = await api('/v1/admin/config/workspace-roots', { method: 'PUT', body: { workspaceRoots: roots } })
    state.config = result
    markResourceSaved('config')
    if (isCurrent()) closeDrawer()
    render()
    toast(editing ? '工作区已更新' : '工作区已添加')
  })
}
