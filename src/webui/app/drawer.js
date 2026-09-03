import { byId, drawer, drawerBackdrop, drawerForm, drawerFooter, keyActionMenu, escapeHtml } from './dom.js'
import { runAction } from './toast.js'

let drawerSubmit = null
let drawerVersion = 0
let returnFocus = null
let background = []
let previousOverflow = ''

function focusable() {
  return Array.from(drawer.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'))
    .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length)
}

function restoreFocus() {
  const previous = returnFocus
  returnFocus = null
  let target = previous?.element
  if (!target?.isConnected && previous) {
    target = Array.from(document.querySelectorAll('button, input, select, textarea')).find((element) =>
      previous.id ? element.id === previous.id : Object.keys(previous.data).length &&
        Object.entries(previous.data).every(([key, value]) => element.dataset[key] === value))
  }
  if (!target?.isConnected || target.closest('.hidden') || target.disabled) target = document.querySelector('.nav-item.active')
  target?.focus({ preventScroll: true })
}

export function getDrawerVersion() { return drawerVersion }

export function handleDrawerKeydown(event) {
  if (drawer.classList.contains('hidden') || event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    closeDrawer()
  }
  if (event.key === 'Tab') {
    const items = focusable()
    const first = items[0] || drawer
    const last = items[items.length - 1] || drawer
    if (!drawer.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
}

document.addEventListener('focusin', (event) => {
  if (!drawer.classList.contains('hidden') && !drawer.contains(event.target)) (focusable()[0] || drawer).focus()
})

export function openDrawer(title, body, submitLabel, onSubmit, danger) {
  const version = ++drawerVersion
  if (drawer.classList.contains('hidden')) {
    const active = document.activeElement
    returnFocus = { element: active, id: active?.id, data: { ...active?.dataset } }
    keyActionMenu.classList.add('hidden')
    document.querySelectorAll('[data-key-menu]').forEach((button) => button.setAttribute('aria-expanded', 'false'))
    drawer.insertBefore(byId('notifications'), drawerFooter)
    background = Array.from(document.body.children).filter((element) => element !== drawer && element !== drawerBackdrop)
      .map((element) => [element, element.inert])
    background.forEach(([element]) => { element.inert = true })
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  byId('drawer-title').textContent = title
  drawerForm.innerHTML = body + '<p class="form-error" data-form-error role="alert"></p>'
  drawerFooter.innerHTML = '<button type="button" class="button" data-close-drawer>取消</button>' +
    (submitLabel ? '<button type="submit" form="drawer-form" class="button ' + (danger ? 'solid-danger' : 'primary') + '">' + escapeHtml(submitLabel) + '</button>' : '')
  drawerSubmit = onSubmit ? (form) => onSubmit(form, () => version === drawerVersion) : null
  drawer.classList.remove('hidden')
  drawerBackdrop.classList.remove('hidden')
  drawer.querySelector('.drawer-body').scrollTop = 0
  byId('notifications').scrollTop = byId('notifications').scrollHeight
  setTimeout(() => {
    if (version !== drawerVersion) return
    const items = focusable()
    const first = items.find((element) => element.matches('input, select, textarea')) || items[0] || drawer
    first.focus({ preventScroll: true })
  }, 0)
}

export function closeDrawer() {
  if (drawer.classList.contains('hidden')) return
  drawerVersion++
  drawer.classList.add('hidden')
  drawerBackdrop.classList.add('hidden')
  drawerForm.innerHTML = ''
  drawerFooter.innerHTML = ''
  drawerSubmit = null
  drawerForm.removeAttribute('aria-busy')
  document.body.appendChild(byId('notifications'))
  background.forEach(([element, inert]) => { element.inert = inert })
  background = []
  document.body.style.overflow = previousOverflow
  restoreFocus()
}

export function openConfirmDrawer(title, message, confirmLabel, onConfirm) {
  openDrawer(title, '<p class="confirm-text">' + escapeHtml(message) + '</p>', confirmLabel, async () => {
    closeDrawer()
    const version = drawerVersion
    await runAction(() => onConfirm(() => version === drawerVersion))
  }, true)
  const cancel = drawerFooter.querySelector('[data-close-drawer]')
  if (cancel) setTimeout(() => { if (cancel.isConnected) cancel.focus() }, 0)
}

export function getDrawerSubmit() {
  return drawerSubmit
}
