import type { IncomingMessage } from 'node:http'
import type {
    AgentdPendingResponse,
    AgentdProtocol,
    AgentdSessionState
} from '../types.js'

/** HTTP input errors are kept separate from route and domain operations. */
export class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
        this.name = 'RequestError'
    }
}

export function assertJsonContentType(request: IncomingMessage) {
    const contentType = stringHeader(request.headers['content-type'])
        .split(';', 1)[0]
        .trim()
        .toLowerCase()
    if (contentType !== 'application/json') {
        throw new RequestError(415, 'Request requires application/json')
    }
}

export async function assertEmptyJsonBody(request: IncomingMessage, maxBytes: number) {
    if (Number(request.headers['content-length'] || 0) <= 0) return
    assertJsonContentType(request)
    const body = await readJsonBody(request, maxBytes)
    assertOnlyKeys(body, [])
}

export async function readJsonBody(request: IncomingMessage, maxBytes: number) {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new RequestError(413, 'Request body is too large')
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) throw new RequestError(413, 'Request body is too large')
        chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return {} as Record<string, unknown>
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('body must be an object')
        }
        return parsed as Record<string, unknown>
    } catch (error) {
        throw new RequestError(400, `Invalid JSON body: ${errorMessage(error)}`)
    }
}

export async function readBytesBody(request: IncomingMessage, maxBytes: number) {
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new RequestError(413, 'Request body is too large')
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const value of request) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        total += chunk.length
        if (total > maxBytes) throw new RequestError(413, 'Request body is too large')
        chunks.push(chunk)
    }
    return Buffer.concat(chunks)
}

export function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
    const accepted = new Set(allowed)
    const unknown = Object.keys(body).filter((key) => !accepted.has(key))
    if (unknown.length) {
        throw new RequestError(400, `Unsupported request fields: ${unknown.join(', ')}`)
    }
}

export function requiredString(value: unknown, name: string) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new RequestError(400, `${name} is required`)
    return text
}

export function requiredRawString(value: unknown, name: string) {
    if (typeof value !== 'string' || !value) throw new RequestError(400, `${name} is required`)
    return value
}

export function requiredMessage(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new RequestError(400, 'message is required')
    }
    return value
}

export function requiredInteger(value: unknown, name: string) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new RequestError(400, `${name} must be an integer`)
    }
    return value
}

export function optionalAttachmentIds(value: unknown) {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 16) {
        throw new RequestError(400, 'attachments must be an array with at most 16 ids')
    }
    return value.map((item) => requiredString(item, 'attachments'))
}

export function normalizePublishPaths(body: Record<string, unknown>): string[] {
    const bodyPaths = body.paths
    if (bodyPaths !== undefined) {
        if (!Array.isArray(bodyPaths) || bodyPaths.length === 0) {
            throw new RequestError(400, 'paths must be a non-empty array of strings')
        }
        if (bodyPaths.length > 32) {
            throw new RequestError(400, 'paths accepts at most 32 entries')
        }
        return bodyPaths.map((item) => requiredString(item, 'paths'))
    }
    return [requiredString(body.path, 'path')]
}

export function normalizedMediaType(value: string | string[] | undefined) {
    const mediaType = stringHeader(value).split(';', 1)[0].trim().toLowerCase()
    return mediaType || undefined
}

export function decodeHeader(value: string | string[] | undefined) {
    const raw = stringHeader(value)
    if (!raw) return ''
    try {
        return decodeURIComponent(raw)
    } catch {
        return raw
    }
}

export function cleanQuery(value: string | null) {
    const text = String(value || '').trim()
    return text || undefined
}

export function boundedLimit(value: string | null) {
    if (!value) return undefined
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1 || number > 200) {
        throw new RequestError(400, 'limit must be an integer between 1 and 200')
    }
    return number
}

export function optionalRunState(value: string | null) {
    if (!value) return undefined
    const states = new Set([
        'created',
        'running',
        'input_required',
        'permission_required',
        'completed',
        'failed',
        'canceled'
    ])
    if (!states.has(value)) throw new RequestError(400, 'Invalid run state')
    return value as AgentdSessionState
}

export function optionalRawString(value: unknown, name: string) {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw new RequestError(400, `${name} must be a string`)
    return value
}

export function optionalString(value: unknown) {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new RequestError(400, 'Expected a string')
    return value.trim() || undefined
}

export function optionalPendingAction(
    value: unknown
): AgentdPendingResponse['action'] | undefined {
    if (value === undefined || value === null || value === '') return undefined
    if (value === 'accept' || value === 'decline' || value === 'cancel') {
        return value
    }
    throw new RequestError(
        400,
        'action must be accept, decline, or cancel'
    )
}

export function optionalBoolean(value: unknown, name: string) {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new RequestError(400, `${name} must be boolean`)
    return value
}

export function optionalNumber(value: unknown, name: string) {
    if (value === undefined) return undefined
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new RequestError(400, `${name} must be an integer`)
    }
    return value
}

export function requiredStringArray(value: unknown, name: string, allowEmpty = false) {
    if (!Array.isArray(value)) throw new RequestError(400, `${name} must be an array of strings`)
    const result = value.map((item) => {
        if (typeof item !== 'string' || !item.trim()) {
            throw new RequestError(400, `${name} must contain non-empty strings`)
        }
        return item.trim()
    })
    if (!allowEmpty && !result.length) {
        throw new RequestError(400, `${name} must contain at least one value`)
    }
    return result
}

function stringHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] || '' : value || ''
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}
