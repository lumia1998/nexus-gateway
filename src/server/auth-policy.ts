import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { AdminSessionStore } from '../auth.js'
import type { AgentdControlPlane } from '../control-plane.js'
import type {
    AgentdApiKeyPrincipal,
    AgentdConfig
} from '../types.js'
import { RequestError } from './validation.js'

export const ADMIN_COOKIE = 'agent_nexus_admin'

export interface FailureLimiter {
    assertAllowed(key: string): void
    failure(key: string): void
    success(key: string): void
}

export function authenticateAdmin(request: IncomingMessage, sessions: AdminSessionStore) {
    const id = cookieValue(request, ADMIN_COOKIE)
    if (!id || !sessions.has(id)) throw new RequestError(401, 'Admin session is required')
}

export function authenticateApiKey(
    request: IncomingMessage,
    config: AgentdConfig,
    controlPlane: AgentdControlPlane | undefined,
    limiter: FailureLimiter
): AgentdApiKeyPrincipal {
    const rateKey = remoteKey(request)
    limiter.assertAllowed(rateKey)
    const value = stringHeader(request.headers.authorization)
    if (!value.startsWith('Bearer ')) {
        limiter.failure(rateKey)
        throw new RequestError(401, 'Bearer API Key is required')
    }
    const secret = value.slice(7)
    // A live control plane is authoritative, including a negative decision.
    const principal = controlPlane
        ? controlPlane.authenticateApiKey(secret)
        : fallbackApiKey(config, secret)
    if (!principal) {
        limiter.failure(rateKey)
        throw new RequestError(401, 'Invalid API Key')
    }
    limiter.success(rateKey)
    return principal
}

export function fallbackApiKey(config: AgentdConfig, secret: string): AgentdApiKeyPrincipal | undefined {
    for (const key of config.apiKeys || []) {
        if (key.enabled && safeEqual(key.secret, secret)) {
            return { id: key.id, scope: structuredClone(key.scope) }
        }
    }
    if (!config.apiKeys?.some((key) => key.id === 'legacy') && config.authToken && safeEqual(config.authToken, secret)) {
        return { id: 'legacy', scope: { allAgents: true, agentIds: [] } }
    }
    return undefined
}

export function assertAgentScope(principal: AgentdApiKeyPrincipal, agentId: string) {
    if (!principal.scope.allAgents && !principal.scope.agentIds.includes(agentId)) {
        throw new RequestError(403, 'API Key is not authorized for this agent')
    }
}

export function isInitialized(config: AgentdConfig, controlPlane?: AgentdControlPlane) {
    return controlPlane?.isInitialized() ?? config.initialized
}

export function needsAdminSetup(config: AgentdConfig, controlPlane?: AgentdControlPlane) {
    const value = (controlPlane as any)?.needsAdminSetup
    return typeof value === 'function' ? value.call(controlPlane) : !config.adminPasswordHash
}

export function consoleHost(request: IncomingMessage) {
    const host = stringHeader(request.headers.host)
    try {
        if (!/^(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/.test(host)) throw new Error()
        const url = new URL(`http://${host}`)
        return url
    } catch { throw new RequestError(403, 'Console Host is not allowed') }
}

export function isDirectConsoleHost(request: IncomingMessage, config: AgentdConfig, hostname: string) {
    const local = request.socket.localAddress?.replace(/^::ffff:/, '')
    const hosts = new Set(['localhost', '127.0.0.1', '[::1]', config.listen.host, local, local && `[${local}]`])
    hosts.delete('0.0.0.0')
    hosts.delete('::')
    return hosts.has(hostname)
}

export function assertConsoleHost(request: IncomingMessage, config: AgentdConfig) {
    const url = consoleHost(request)
    if (!isDirectConsoleHost(request, config, url.hostname) && !config.publicOrigins?.some((origin) => originMatchesHost(origin, request))) {
        throw new RequestError(403, 'Console Host is not allowed')
    }
}

export function assertTrustedOrigin(request: IncomingMessage, config: AgentdConfig) {
    const origin = stringHeader(request.headers.origin)
    if (!origin) throw new RequestError(403, 'Same-origin request is required')
    let parsed: URL
    try {
        parsed = new URL(origin)
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error()
    } catch {
        throw new RequestError(403, 'Request origin is invalid')
    }
    const host = consoleHost(request)
    const direct = parsed.protocol === 'http:' && isDirectConsoleHost(request, config, host.hostname)
    if (!originMatchesHost(origin, request) || (!direct && !config.publicOrigins?.includes(origin))) {
        throw new RequestError(403, 'Cross-origin admin request is not allowed')
    }
}

export function originMatchesHost(origin: string, request: IncomingMessage) {
    const parsed = new URL(origin)
    return new URL(`${parsed.protocol}//${stringHeader(request.headers.host)}`).origin === parsed.origin
}

export function cookieValue(request: IncomingMessage, name: string) {
    const cookie = stringHeader(request.headers.cookie)
    for (const part of cookie.split(';')) {
        const index = part.indexOf('=')
        if (index < 0 || part.slice(0, index).trim() !== name) continue
        return part.slice(index + 1).trim()
    }
    return ''
}

export function adminCookie(value: string, ttlMs: number, config: AgentdConfig) {
    return [
        `${ADMIN_COOKIE}=${value}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(ttlMs / 1000)}`,
        ...(config.secureAdminCookies ? ['Secure'] : [])
    ].join('; ')
}

export function clearAdminCookie(config: AgentdConfig) {
    return [
        `${ADMIN_COOKIE}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=0',
        ...(config.secureAdminCookies ? ['Secure'] : [])
    ].join('; ')
}

export function isMutating(method?: string) {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

export function remoteKey(request: IncomingMessage) {
    return request.socket.remoteAddress || 'unknown'
}

export function stringHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] || '' : value || ''
}

function safeEqual(left: string, right: string) {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
}
