import { byId } from './dom.js'

export function toast(message, error) {
  const item = document.createElement('div')
  item.className = 'toast' + (error ? ' error' : '')
  item.textContent = message
  byId('toast-region').appendChild(item)
  setTimeout(() => item.remove(), 4200)
}

export async function runAction(task) {
  try { await task() } catch (error) { toast(error.message, true) }
}

