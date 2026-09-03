import { showLogin } from './screens.js'

export async function api(path, options) {
  const settings = Object.assign({ credentials: 'same-origin' }, options || {})
  settings.headers = Object.assign({}, settings.headers || {})
  if (settings.body && typeof settings.body !== 'string') {
    settings.headers['Content-Type'] = 'application/json'
    settings.body = JSON.stringify(settings.body)
  }
  const response = await fetch(path, settings)
  let value = null
  try { value = await response.json() } catch {}
  if (!response.ok) {
    if (response.status === 401 && path.indexOf('/v1/admin/') === 0) showLogin()
    const message = value && value.error ? value.error : '请求失败（HTTP ' + response.status + '）'
    const error = new Error(localizeError(message))
    error.status = response.status
    throw error
  }
  return value
}

export function localizeError(message) {
  const messages = {
    'Invalid Console Password': '控制台密码不正确',
    'Console setup is required': '请先完成控制台初始化',
    'Console setup is already complete': '控制台已完成初始化',
    'Console Password confirmation does not match': '两次输入的控制台密码不一致',
    'Console Password must contain at least 12 characters': '控制台密码至少需要 12 个字符',
    'Console Password must not exceed 1024 bytes': '控制台密码不能超过 1024 字节',
    'Console Password must not contain NUL bytes': '控制台密码包含不支持的字符',
    'Current Console Password is incorrect': '当前控制台密码不正确',
    'Gateway setup is required': '请先完成网关初始化',
    'Admin session is required': '管理员会话已失效，请重新登录',
    'Bearer API Key is required': '缺少 Bearer API 密钥',
    'Invalid API Key': 'API 密钥无效',
    'API Key is not authorized for this agent': '该 API 密钥无权访问此智能体',
    'API Key already exists': 'API 密钥已存在',
    'API Key not found': '未找到 API 密钥',
    'API Key name is required': '请输入 API 密钥名称',
    'API Key name is too long': 'API 密钥名称过长',
    'Custom API Key must contain at least 16 characters': '自定义 API 密钥至少需要 16 个字符',
    'Custom API Key must not exceed 512 bytes': '自定义 API 密钥不能超过 512 字节',
    'Custom API Key contains an unsupported value': '自定义 API 密钥包含不支持的内容',
    'workspaceRoots must contain at least one path': '至少需要保留一个工作区根目录',
    'A2A authentication value is required': '请输入 A2A 认证凭据',
    'A2A authentication value is invalid': 'A2A 认证凭据无效',
    'A2A Agent Card URL is required': '请输入 Agent Card URL',
    'A2A Agent Card URL is invalid': 'Agent Card URL 无效',
    'A2A Agent Card URL must use http(s) without credentials or a fragment': 'Agent Card URL 必须使用 HTTP(S)，且不能包含凭据或片段',
    'preferredTransport must be auto, jsonrpc, or http-json': '首选传输必须是自动、JSON-RPC 或 HTTP+JSON',
    'A valid A2A header name is required': '请输入有效的 A2A 请求头名称',
    'Too many authentication attempts': '认证失败次数过多，请稍后再试',
    'Request body is too large': '请求内容过大',
    'Request requires application/json': '请求必须使用 application/json',
    'Same-origin request is required': '此操作必须从当前控制台页面发起',
    'Request origin is invalid': '请求来源无效',
    'Cross-origin admin request is not allowed': '不允许跨域管理请求',
    'Control plane is unavailable': '管理控制面当前不可用',
    'Agent Nexus run not found': '未找到运行记录',
    'Internal server error': '服务器内部错误'
  }
  if (messages[message]) return messages[message]
  const workspaceConflict = /^Workspace change would exclude agent: (.+)$/.exec(message)
  if (workspaceConflict) return '请先修改智能体「' + workspaceConflict[1] + '」的工作区，再删除或编辑此工作区'
  const missingAgent = /^Configured agent not found: (.+)$/.exec(message)
  if (missingAgent) return '未找到已配置的智能体：' + missingAgent[1]
  const timeout = /^timeout must be between (\d+) and (\d+)$/.exec(message)
  if (timeout) return '超时时间必须介于 ' + Math.round(Number(timeout[1]) / 1000) + ' 和 ' + Math.round(Number(timeout[2]) / 1000) + ' 秒之间'
  const runtimeRange = /^(sessionTtlMs|promptTimeoutMs|cleanupIntervalMs) must be between (\d+) and (\d+)$/.exec(message)
  if (runtimeRange) {
    const units = {
      sessionTtlMs: ['会话空闲有效期', '小时', 3_600_000],
      promptTimeoutMs: ['ACP 任务超时', '分钟', 60_000],
      cleanupIntervalMs: ['清理任务周期', '秒', 1000]
    }
    const [label, unit, divisor] = units[runtimeRange[1]]
    return label + '必须介于 ' + Math.round(Number(runtimeRange[2]) / divisor) + ' 和 ' + Math.round(Number(runtimeRange[3]) / divisor) + ' ' + unit + '之间'
  }
  return message
}
