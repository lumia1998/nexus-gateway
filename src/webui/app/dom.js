export const byId = (id) => document.getElementById(id)

export const setupScreen = byId('setup-screen')
export const loginScreen = byId('login-screen')
export const appRoot = byId('app')
export const content = byId('page-content')
export const pageStats = byId('page-stats')
export const pageToolbar = byId('page-toolbar')
export const pageResults = byId('page-results')
export const pageStatus = byId('page-status')
export const actions = byId('page-actions')
export const drawer = byId('drawer')
export const drawerBackdrop = byId('drawer-backdrop')
export const drawerForm = byId('drawer-form')
export const drawerFooter = byId('drawer-footer')

export const keyActionMenu = document.createElement('div')
keyActionMenu.className = 'key-action-menu hidden'
keyActionMenu.id = 'key-action-menu'
keyActionMenu.setAttribute('role', 'menu')
keyActionMenu.setAttribute('aria-label', 'API 密钥操作')
document.body.appendChild(keyActionMenu)

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export const selected = (value, expected) => (value === expected ? ' selected' : '')
export const checked = (value) => (value ? ' checked' : '')
