const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

export function shortId(value) {
  return String(value || '').slice(0, 8)
}

export function formatDate(timestamp) {
  if (!timestamp) return '—'
  return dateFormatter.format(new Date(timestamp))
}

export function formatDuration(run) {
  const ms = run.durationMs != null ? run.durationMs : Math.max(0, Date.now() - run.startedAt)
  if (ms < 1000) return ms + ' 毫秒'
  if (ms < 60_000) return Math.round(ms / 1000) + ' 秒'
  if (ms < 3_600_000) return Math.floor(ms / 60_000) + ' 分 ' + Math.round(ms % 60_000 / 1000) + ' 秒'
  return Math.floor(ms / 3_600_000) + ' 小时 ' + Math.round(ms % 3_600_000 / 60_000) + ' 分'
}

export const runStateLabels = {
  created: '已创建',
  running: '运行中',
  input_required: '等待输入',
  permission_required: '等待授权',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消'
}

export function runStatusLabel(value) {
  return runStateLabels[value] || value
}

export function permissionLabel(value) {
  if (value === 'ask') return '询问'
  if (value === 'allow') return '自动允许单次'
  if (value === 'deny') return '拒绝'
  return value || '—'
}

export function formatSize(bytes) {
  if (bytes == null) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

export const kindLabels = {
  image: '图片',
  video: '视频',
  audio: '音频',
  file: '文件'
}

export function kindLabel(kind) {
  return kindLabels[kind] || kind || '文件'
}
