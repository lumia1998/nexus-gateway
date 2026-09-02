import { byId, drawer, drawerBackdrop, drawerForm, drawerFooter, escapeHtml } from './dom.js'
import { runAction } from './toast.js'

let drawerSubmit = null

export function openDrawer(title, body, submitLabel, onSubmit, danger) {
  byId('drawer-title').textContent = title
  drawerForm.innerHTML = body + '<p class="form-error" data-form-error></p>'
  drawerFooter.innerHTML = '<button type="button" class="button" data-close-drawer>取消</button>' +
    (submitLabel ? '<button type="submit" form="drawer-form" class="button ' + (danger ? 'solid-danger' : 'primary') + '">' + escapeHtml(submitLabel) + '</button>' : '')
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
  drawerFooter.innerHTML = ''
  drawerSubmit = null
}

export function openConfirmDrawer(title, message, confirmLabel, onConfirm) {
  openDrawer(title, '<p class="confirm-text">' + escapeHtml(message) + '</p>', confirmLabel, async () => {
    closeDrawer()
    await runAction(onConfirm)
  }, true)
  const cancel = drawerFooter.querySelector('[data-close-drawer]')
  if (cancel) setTimeout(() => cancel.focus(), 0)
}

export function getDrawerSubmit() {
  return drawerSubmit
}

