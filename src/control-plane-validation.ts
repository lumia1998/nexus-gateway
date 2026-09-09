import { timingSafeEqual } from 'node:crypto'
import { validateAdminPassword } from './auth.js'
import type { AgentdProtocol,AgentdDriverKind,PermissionPolicy,A2ATransportPreference,A2AAuthType,AgentdApiKeyScope } from './types.js'

export interface AgentdAgentUpdate {
    protocol?: AgentdProtocol
    driver?: AgentdDriverKind
    name?: string
    description?: string
    enabled?: boolean
    workspace?: string
    permissionPolicy?: PermissionPolicy
    permissionTimeoutMs?: number
    agentCardUrl?: string
    agentUrl?: string
    preferredTransport?: A2ATransportPreference
    authType?: A2AAuthType
    authValue?: string
    authHeaderName?: string
    timeoutMs?: number
    taskTimeoutMs?: number | null
    streamIdleTimeoutMs?: number | null
}

export interface AgentdApiKeyUpdate {
    name?: string
    enabled?: boolean
    scope?: AgentdApiKeyScope
}

export interface AgentdRuntimeSettingsUpdate {
    sessionTtlMs: number
    promptTimeoutMs: number
    cleanupIntervalMs: number
}

export class ControlPlaneError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}

export function validateRuntimeSettings(update: AgentdRuntimeSettingsUpdate) {
    validateIntegerRange(update.sessionTtlMs, 60_000, 30 * 24 * 60 * 60 * 1000, 'sessionTtlMs')
    validateIntegerRange(update.promptTimeoutMs, 10_000, 24 * 60 * 60 * 1000, 'promptTimeoutMs')
    validateIntegerRange(update.cleanupIntervalMs, 5_000, 60 * 60 * 1000, 'cleanupIntervalMs')
}

export function validateIntegerRange(value: number, min: number, max: number, name: string) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ControlPlaneError(400, `${name} must be between ${min} and ${max}`)
    }
}

export function validateUpdate(update: AgentdAgentUpdate) {
    if (update.protocol !== undefined && update.protocol !== 'acp' && update.protocol !== 'a2a') {
        throw new ControlPlaneError(400, 'protocol must be acp or a2a')
    }
    if (
        update.permissionPolicy !== undefined &&
        update.permissionPolicy !== 'ask' &&
        update.permissionPolicy !== 'allow' &&
        update.permissionPolicy !== 'deny'
    ) {
        throw new ControlPlaneError(400, 'permissionPolicy must be ask, allow, or deny')
    }
    if (
        update.preferredTransport !== undefined &&
        !['auto', 'jsonrpc', 'http-json'].includes(update.preferredTransport)
    ) {
        throw new ControlPlaneError(
            400,
            'preferredTransport must be auto, jsonrpc, or http-json'
        )
    }
}

export function validateAgentId(value: string) {
    const id = decodeURIComponent(value).trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
        throw new ControlPlaneError(400, 'Invalid Agent ID')
    }
    return id
}

export function validateOpaqueId(value: string, label: string) {
    const id = decodeURIComponent(value).trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) {
        throw new ControlPlaneError(400, `Invalid ${label} ID`)
    }
    return id
}

export function validatePassword(value: string, confirmation: string) {
    if (value !== confirmation) {
        throw new ControlPlaneError(400, 'Console Password confirmation does not match')
    }
    try {
        return validateAdminPassword(value)
    } catch (error) {
        throw new ControlPlaneError(400, errorMessage(error))
    }
}

export function validateKeyName(value: string) {
    const name = cleanString(value)
    if (!name) throw new ControlPlaneError(400, 'API Key name is required')
    if (name.length > 80) throw new ControlPlaneError(400, 'API Key name is too long')
    return name
}

export function validateApiKeySecret(value: string) {
    const secret = cleanString(value)
    if (secret.length < 16) {
        throw new ControlPlaneError(400, 'Custom API Key must contain at least 16 characters')
    }
    if (Buffer.byteLength(secret, 'utf8') > 512) {
        throw new ControlPlaneError(400, 'Custom API Key must not exceed 512 bytes')
    }
    if (/^env:/i.test(secret) || /[\u0000-\u001f\u007f]/.test(secret)) {
        throw new ControlPlaneError(400, 'Custom API Key contains an unsupported value')
    }
    return secret
}

export function validateA2ASecret(value: string) {
    const secret = cleanString(value)
    if (!secret) return ''
    if (
        /^env:/i.test(secret) ||
        Buffer.byteLength(secret, 'utf8') > 4096 ||
        /[\u0000\r\n]/.test(secret)
    ) {
        throw new ControlPlaneError(400, 'A2A authentication value is invalid')
    }
    return secret
}

export function validateAgentUrl(value: string) {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new ControlPlaneError(400, 'A2A Agent Card URL is invalid')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new ControlPlaneError(
            400,
            'A2A Agent Card URL must use http(s) without credentials or a fragment'
        )
    }
    return url.toString().replace(/\/$/, '')
}

export function defaultAgentCardUrl(agentUrl: string | undefined) {
    if (!agentUrl) return undefined
    return new URL('/.well-known/agent-card.json', agentUrl).toString()
}

export function clampTimeout(value: number | undefined, fallback: number, min: number, max: number) {
    if (value === undefined) return fallback
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ControlPlaneError(400, `timeout must be between ${min} and ${max}`)
    }
    return value
}

export function preservedAcpAdvanced(previous: Record<string, unknown>) {
    const result: Record<string, unknown> = {}
    for (const key of ['command', 'args', 'probeArgs', 'inheritEnv', 'env']) {
        if (previous[key] !== undefined) result[key] = structuredClone(previous[key])
    }
    return result
}

export function setOptionalString(
    target: Record<string, unknown>,
    key: string,
    value: string | undefined
) {
    const text = cleanString(value)
    if (text) target[key] = text
    else delete target[key]
}

export function validHeaderName(value: string) {
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
}

export function safeSecretEqual(left: string, right: string) {
    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function cleanString(value: unknown) {
    return typeof value === 'string' ? value.trim() : ''
}

export function recordValue(value: unknown): Record<string, any> {
    return isRecord(value) ? { ...value } : {}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
