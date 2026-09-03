import { byId } from './dom.js'

export function toast(message, error) {
  const item = document.createElement('div')
  item.className = 'toast' + (error ? ' error' : '')
  item.textContent = message
  byId(error ? 'toast-alert' : 'toast-status').appendChild(item)
  const region = byId('notifications')
  if (region.closest('#drawer')) region.scrollTop = region.scrollHeight
  setTimeout(() => item.remove(), 4200)
}

export async function runAction(task) {
  try { await task() } catch (error) { toast(error.message, true) }
}

export async function withBusy(button, task) {
  if (!button) return task()
  if (button.getAttribute('aria-busy') === 'true') return
  const disabled = button.disabled
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  try { return await task() } finally {
    button.disabled = disabled
    button.removeAttribute('aria-busy')
  }
}
