import { byId } from './dom.js'

export function applyTheme(preference) {
  const theme = preference === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : preference
  document.documentElement.dataset.theme = theme
  const select = byId('theme-select')
  if (select) select.value = preference
}

