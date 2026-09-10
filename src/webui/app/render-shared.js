import { state, pageMeta } from './state.js'
import { byId, pageStats, pageToolbar, pageResults, pageStatus, actions, escapeHtml } from './dom.js'
import { icons } from './icons.js'

let actionsPage = null
let actionsHtml = null
let toolbarSignature = null
let resultsHtml = null
export function resetSharedView() {
 actionsPage = actionsHtml = toolbarSignature = resultsHtml = null
 for (const element of [actions,pageStats,pageToolbar,pageResults,pageStatus]) element.replaceChildren()
}

export function setResults(html) {
  if (resultsHtml === html) return
  resultsHtml = html
  const focused = pageResults.contains(document.activeElement) ? document.activeElement : null
  pageResults.innerHTML = html
  if (focused) {
    const data = Object.entries(focused.dataset)
    const replacement = Array.from(pageResults.querySelectorAll('button, input, select')).find((element) =>
      focused.id ? focused.id === element.id : data.length && data.every(([key, value]) => element.dataset[key] === value))
    ;(replacement || document.querySelector('.nav-item.active'))?.focus({ preventScroll: true })
  }
}

export function setActions(html) {
  if (actionsPage === state.page && actionsHtml === html) return
  actionsPage = state.page
  actionsHtml = html
  actions.innerHTML = html
}

export function setToolbar(signature, html = '') {
  if (toolbarSignature === signature) return
  toolbarSignature = signature
  pageToolbar.innerHTML = html
}

export function announce(message) {
  const summary = pageMeta[state.page] + '：' + message
  if (pageStatus.textContent !== summary) pageStatus.textContent = summary
}

export function stat(label, value, href) {
  const open = href ? '<a class="stat" href="' + escapeHtml(href) + '">' : '<div class="stat">'
  const close = href ? '</a>' : '</div>'
  return open + '<span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong>' + close
}

export function emptyState(icon, title, text, cta) {
  return '<div class="empty-state">' + icon + '<strong>' + escapeHtml(title) + '</strong>' +
    (text ? '<span>' + escapeHtml(text) + '</span>' : '') +
    (cta ? '<button type="button" class="button primary" data-empty-action="' + escapeHtml(cta.action) + '">' + icons.plus + escapeHtml(cta.label) + '</button>' : '') +
    '</div>'
}

export function bindSearch(id, apply) {
  const input = byId(id)
  if (input.dataset.searchBound) return
  input.dataset.searchBound = 'true'
  input.addEventListener('compositionstart', () => { input.dataset.composing = 'true' })
  input.addEventListener('compositionend', () => { delete input.dataset.composing; apply(input.value) })
  input.addEventListener('input', (event) => {
    if (!event.isComposing && !input.dataset.composing) apply(input.value)
  })
}

export function preciseUnitValue(value, unit, fallback) {
  const number = Number.isFinite(Number(value)) ? Number(value) : fallback
  const rendered = (number / unit).toFixed(7)
  return rendered.replace(/0+$/, '').replace(/\.$/, '')
}
