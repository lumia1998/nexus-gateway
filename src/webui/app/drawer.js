import { byId, drawer, drawerBackdrop, drawerForm, escapeHtml } from './dom.js'

let drawerSubmit = null

export function openDrawer(title, body, submitLabel, onSubmit) {
  byId('drawer-title').textContent = title
  drawerForm.innerHTML =
    body +
    '<div class="drawer-footer"><button type="button" class="button" data-close-drawer>取消</button>' +
    (submitLabel ? '<button type="submit" class="button primary">' + escapeHtml(submitLabel) + '</button>' : '') +
    '</div><p class="form-error" data-form-error></p>'
  drawerSubmit = onSubmit || null
  drawer.classList.remove('hidden')
  drawerBackdrop.classList.remove('hidden')
  const first = drawerForm.querySelector('input, select, textarea')
  if (first) setTimeout(() => first.focus(), 0)
}

export function closeDrawer() {
  drawer.classList.add('hidden')
  drawerBackdrop.classList.add('hidden')
  drawerForm.innerHTML = ''
  drawerSubmit = null
}

export function getDrawerSubmit() {
  return drawerSubmit
}

