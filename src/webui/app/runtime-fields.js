import { escapeHtml, selected } from './dom.js'

export const policyOptions = [
  ['ask', '由调用者决定'], ['auto', '自动授权'], ['bypass', '原生无人值守'], ['allow', '仅自动允许单次'], ['deny', '拒绝']
]

export function policySelect(value, id = 'task-policy') {
  return '<div class="field"><label for="' + id + '">权限策略</label><select id="' + id + '" name="permissionPolicy">' + policyOptions.map(([key, label]) => '<option value="' + key + '"' + selected(value, key) + '>' + label + '</option>').join('') + '</select></div>'
}

export function selectionFields(value = {}, prefix = 'task') {
  return ['model', 'effort', 'mode'].map((key, index) => '<div class="field"><label for="' + prefix + '-' + key + '">' + ['模型', '思考强度', '会话模式'][index] + '</label><input id="' + prefix + '-' + key + '" name="' + key + '" value="' + escapeHtml(value[key] || '') + '" list="' + prefix + '-' + key + '-values" placeholder="使用智能体默认值"><datalist id="' + prefix + '-' + key + '-values"></datalist></div>').join('')
}

export function lifecycleFields(value) {
  return '<details><summary>运行期限与资源</summary>' + [
    ['startupTimeoutMs', '连接超时（秒）', 30000, 1], ['localTaskTimeoutMs', '任务执行期限（秒）', value.taskTimeoutMs || 1800000, 10],
    ['stallTimeoutMs', '无进展期限（秒，0 关闭）', 600000, 0], ['idleUnloadMs', '空闲卸载（秒，0 关闭）', 900000, 0]
  ].map(([key, label, fallback, min]) => '<div class="field"><label for="f-' + key + '">' + label + '</label><input id="f-' + key + '" name="' + key + '" type="number" min="' + min + '" max="' + (key === 'startupTimeoutMs' ? 600 : 86400) + '" step="0.001" value="' + Number(value[key] ?? fallback) / 1000 + '"></div>').join('') + '</details>'
}

export function readSelection(data) {
  const options = {}
  for (const key of ['model', 'effort', 'mode', 'permissionPolicy']) {
    const value = String(data.get(key) || '').trim()
    if (value) options[key] = value
  }
  return options
}

export function populateOptions(runtime, prefix = 'task') {
  const flatten = items => (items || []).flatMap(item => item.options ? flatten(item.options) : [item])
  for (const [category, ids] of [['model', ['model']], ['effort', ['thinking', 'thinkingEffort', 'thought', 'effort', 'reasoning_effort']], ['mode', ['mode']]]) {
    const option = (runtime.configOptions || []).find(item => item.category === (category === 'effort' ? 'thought_level' : category) || ids.includes(item.id))
    const values = option ? flatten(option.options).map(item => ({ value: item.value, name: item.name })) : category === 'mode' ? (runtime.modes?.availableModes || []).map(item => ({ value: item.id, name: item.name })) : []
    const list = document.getElementById(prefix + '-' + category + '-values')
    if (list) list.innerHTML = values.map(item => '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.name || item.value) + '</option>').join('')
  }
}
