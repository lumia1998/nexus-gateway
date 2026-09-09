import { state } from './state.js'
import { byId, escapeHtml, selected } from './dom.js'

import { api } from './api.js'
import { toast, withBusy } from './toast.js'

import { showLogin } from './screens.js'
import { applyTheme } from './theme.js'
import { markResourceSaved } from './data.js'

import { setResults, setActions, preciseUnitValue } from './render-shared.js'

export function runtimeValue(data, name, unit) {
  const value = Number(data.get(name))
  if (!Number.isFinite(value)) throw new Error('请填写有效的运行参数')
  return Math.round(value * unit)
}

export function renderSettings() {
  const existingForm = byId('settings-form')
  const existingPasswordForm = byId('password-form')
  if (existingForm && existingPasswordForm) {
    existingForm.refreshRuntime?.()
    return
  }
  const initialRuntime = {
    sessionTtlMs: Number(state.config.sessionTtlMs || 24 * 60 * 60 * 1000),
    promptTimeoutMs: Number(state.config.promptTimeoutMs || 30 * 60 * 1000),
    cleanupIntervalMs: Number(state.config.cleanupIntervalMs || 60_000)
  }
  const runtimeUnavailable = !state.resources.config.lastSuccessAt
  const configLoading = runtimeUnavailable
  const sessionTtlHours = preciseUnitValue(initialRuntime.sessionTtlMs, 3_600_000, 24)
  const promptTimeoutMinutes = preciseUnitValue(initialRuntime.promptTimeoutMs, 60_000, 30)
  const cleanupIntervalSeconds = preciseUnitValue(initialRuntime.cleanupIntervalMs, 1000, 60)
  const initialRuntimeInput = { sessionTtlHours, promptTimeoutMinutes, cleanupIntervalSeconds }
  const theme = localStorage.getItem('agent-nexus-theme') || 'system'
  setActions('<button id="settings-save" type="submit" form="settings-form" class="button primary"' + (configLoading ? ' disabled' : '') + '>保存更改</button><button id="password-save" type="submit" form="password-form" class="button">保存密码</button>')
  setResults('<form id="settings-form" class="settings-layout">' +
    '<section class="settings-section settings-runtime"><div class="settings-section-heading"><h2>运行参数</h2>' +
    '<p class="settings-note">写入网关配置文件，对所有客户端生效；会话 TTL 与清理周期立即由会话管理器采用，ACP 任务超时由新建 Session 采用。</p></div>' +
    '<div class="settings-fields">' +
    '<div class="field"><label for="session-ttl-hours">会话空闲有效期（小时）</label><input id="session-ttl-hours" name="sessionTtlHours" type="number" min="0.0166667" max="720" step="any" value="' + escapeHtml(sessionTtlHours) + '"' + (configLoading ? ' disabled' : '') + '><small class="field-help">无活动超过该时长后释放会话，支持小数小时以保留分钟级设置。默认 24 小时。</small></div>' +
    '<div class="field"><label for="prompt-timeout-minutes">单次 ACP 任务超时（分钟）</label><input id="prompt-timeout-minutes" name="promptTimeoutMinutes" type="number" min="0.1666667" max="1440" step="any" value="' + escapeHtml(promptTimeoutMinutes) + '"' + (configLoading ? ' disabled' : '') + '><small class="field-help">超时后任务记为失败并释放资源，支持小数分钟以保留秒级设置。默认 30 分钟。</small></div>' +
    '<div class="field"><label for="cleanup-interval-seconds">清理任务周期（秒）</label><input id="cleanup-interval-seconds" name="cleanupIntervalSeconds" type="number" min="5" max="3600" step="0.001" value="' + escapeHtml(cleanupIntervalSeconds) + '"' + (configLoading ? ' disabled' : '') + '><small class="field-help">扫描空闲会话与过期记录的间隔，支持毫秒级设置。默认 60 秒。</small></div>' +
    '</div>' +
    '<p class="settings-note" data-runtime-loading role="status"' + (configLoading ? '' : ' hidden') + '>运行参数尚未成功读取，暂不能保存默认值；可单独修改控制台密码。</p>' +
    '<p class="form-error settings-form-error" data-form-error role="alert"></p>' +
    '</section></form>' +
    '<section class="settings-section settings-appearance"><div class="settings-section-heading"><h2>外观</h2>' +
    '<p class="settings-note">仅影响当前浏览器。</p></div>' +
    '<div class="settings-fields"><div class="field"><label for="theme-select">界面主题</label>' +
    '<select id="theme-select"><option value="system"' + selected(theme, 'system') + '>跟随系统</option><option value="light"' + selected(theme, 'light') + '>浅色</option><option value="dark"' + selected(theme, 'dark') + '>深色</option></select>' +
    '</div></div></section>' +
    '<form id="password-form" class="settings-layout settings-password-layout">' +
    '<section class="settings-section settings-account"><div class="settings-section-heading"><h2>账户</h2></div>' +
    '<div class="settings-account-row"><div class="settings-account-copy"><strong>控制台密码</strong><p>用于登录当前管理控制台。</p></div>' +
    '<div class="settings-account-fields"><div class="field"><label for="settings-current-password">当前密码</label><input id="settings-current-password" name="currentPassword" type="password" autocomplete="current-password"></div>' +
    '<div class="field"><label for="settings-new-password">新密码</label><input id="settings-new-password" name="newPassword" type="password" minlength="12" autocomplete="new-password"></div>' +
    '<div class="field"><label for="settings-confirm-password">确认新密码</label><input id="settings-confirm-password" name="confirmPassword" type="password" minlength="12" autocomplete="new-password"></div></div></div>' +
    '</section>' +
    '<p class="form-error settings-password-error" data-password-error role="alert"></p>' +
    '</form>')
  const form = byId('settings-form')
  const passwordForm = byId('password-form')
  // Update only the untouched runtime fields. Password entry, focus and IME
  // composition must survive a late configuration response or retry.
  form.refreshRuntime = () => {
    const save = byId('settings-save')
    if (save.getAttribute('aria-busy') === 'true') return
    const unavailable = !state.resources.config.lastSuccessAt
    save.disabled = unavailable
    if (form.dataset.dirty === 'true') return
    const fields = [
      ['sessionTtlHours', 'sessionTtlMs', 3_600_000, 86_400_000],
      ['promptTimeoutMinutes', 'promptTimeoutMs', 60_000, 1_800_000],
      ['cleanupIntervalSeconds', 'cleanupIntervalMs', 1000, 60_000]
    ]
    for (const [name, key, unit, fallback] of fields) {
      initialRuntime[key] = Number(state.config[key] ?? fallback)
      initialRuntimeInput[name] = preciseUnitValue(initialRuntime[key], unit, fallback)
      const input = form.elements.namedItem(name)
      if (input.value !== initialRuntimeInput[name]) input.value = initialRuntimeInput[name]
      input.disabled = unavailable
    }
    form.querySelector('[data-runtime-loading]').hidden = !unavailable
  }
  const markDirty = () => { form.dataset.dirty = 'true' }
  const markPasswordDirty = () => { passwordForm.dataset.dirty = 'true' }
  form.addEventListener('input', markDirty)
  form.addEventListener('change', markDirty)
  passwordForm.addEventListener('input', markPasswordDirty)
  passwordForm.addEventListener('change', markPasswordDirty)
  form.onsubmit = async (event) => {
    event.preventDefault()
    await withBusy(event.submitter || form.querySelector('[type="submit"]'), async () => {
      const error = form.querySelector('[data-form-error]')
      error.textContent = ''
      const data = new FormData(form)
      let values
      let runtimeChanged = false
      try {
        if (!state.resources.config.lastSuccessAt) throw new Error('运行参数尚未成功读取，请稍后重试')
        values = {
          sessionTtlMs: String(data.get('sessionTtlHours')) === initialRuntimeInput.sessionTtlHours ? initialRuntime.sessionTtlMs : runtimeValue(data, 'sessionTtlHours', 3_600_000),
          promptTimeoutMs: String(data.get('promptTimeoutMinutes')) === initialRuntimeInput.promptTimeoutMinutes ? initialRuntime.promptTimeoutMs : runtimeValue(data, 'promptTimeoutMinutes', 60_000),
          cleanupIntervalMs: String(data.get('cleanupIntervalSeconds')) === initialRuntimeInput.cleanupIntervalSeconds ? initialRuntime.cleanupIntervalMs : runtimeValue(data, 'cleanupIntervalSeconds', 1000)
        }
        runtimeChanged = String(data.get('sessionTtlHours')) !== initialRuntimeInput.sessionTtlHours ||
          String(data.get('promptTimeoutMinutes')) !== initialRuntimeInput.promptTimeoutMinutes ||
          String(data.get('cleanupIntervalSeconds')) !== initialRuntimeInput.cleanupIntervalSeconds
      } catch (reason) {
        error.textContent = reason.message
        return
      }
      let runtimeSaved = false
      let runtimeFailure
      if (runtimeChanged) {
        try {
          const result = await api('/v1/admin/config/runtime', { method: 'PUT', body: values })
          state.config = { ...state.config, ...result }
          markResourceSaved('config')
          Object.assign(initialRuntime, values)
          for (const name of Object.keys(initialRuntimeInput)) initialRuntimeInput[name] = String(data.get(name))
          runtimeSaved = true
        } catch (reason) { runtimeFailure = reason }
      }
      if (runtimeFailure) {
        const messages = []
        if (runtimeFailure) messages.push('运行参数保存失败：' + runtimeFailure.message)
        error.textContent = messages.join('；')
      } else if (runtimeSaved) {
        const currentData = new FormData(form)
        form.dataset.dirty = String(Object.keys(initialRuntimeInput).some((name) => String(currentData.get(name)) !== initialRuntimeInput[name]))
        toast('运行参数已保存；会话 TTL 与清理周期立即生效，ACP 任务超时对新建 Session 生效')
      } else {
        form.dataset.dirty = 'false'
        toast('没有需要保存的运行参数更改')
      }
    })
  }
  passwordForm.onsubmit = async (event) => {
    event.preventDefault()
    await withBusy(event.submitter || byId('password-save'), async () => {
      const error = passwordForm.querySelector('[data-password-error]')
      error.textContent = ''
      const data = new FormData(passwordForm)
      const currentPassword = String(data.get('currentPassword') || '')
      const newPassword = String(data.get('newPassword') || '')
      const confirmPassword = String(data.get('confirmPassword') || '')
      try {
        if (!currentPassword || !newPassword || !confirmPassword) throw new Error('请完整填写密码修改信息')
        if (newPassword !== confirmPassword) throw new Error('两次输入的控制台密码不一致')
        if (newPassword.length < 12) throw new Error('控制台密码至少需要 12 个字符')
        if (new TextEncoder().encode(newPassword).length > 1024) throw new Error('控制台密码不能超过 1024 字节')
        if (newPassword.includes('\u0000')) throw new Error('控制台密码包含不支持的字符')
        await api('/v1/admin/password', { method: 'PUT', body: { currentPassword, newPassword, confirmPassword } })
        showLogin()
        toast('控制台密码已修改，请重新登录。')
      } catch (reason) { error.textContent = reason.message }
    })
  }
  byId('theme-select').onchange = (event) => {
    localStorage.setItem('agent-nexus-theme', event.target.value)
    applyTheme(event.target.value)
  }
}
