import { timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import {
    ControlPlaneError,
    type AgentdAgentUpdate,
    type AgentdControlPlane
} from './control-plane.js'
import type {
    AgentdConfig,
    AgentdDriverKind,
    AgentdEvent,
    PermissionPolicy
} from './types.js'
import { SessionManager, SessionNotFoundError } from './session.js'
import { redirectToAgentdWebUi, writeAgentdWebUi } from './webui.js'

export function createAgentdServer(
    config: AgentdConfig,
    sessions: SessionManager,
    controlPlane?: AgentdControlPlane
) {
    return http.createServer((request, response) => {
        void handleRequest(config, sessions, controlPlane, request, response).catch((error) => {
            if (response.headersSent) {
                response.destroy(error instanceof Error ? error : undefined)
                return
            }
            const status =
                error instanceof SessionNotFoundError
                    ? 404
                    : error instanceof ControlPlaneError
                      ? error.status
                    : error instanceof RequestError
                      ? error.status
                      : 500
            writeJson(response, status, {
                error: error instanceof Error ? error.message : String(error)
            })
        })
    })
}

async function handleRequest(
    config: AgentdConfig,
    sessions: SessionManager,
    controlPlane: AgentdControlPlane | undefined,
    request: IncomingMessage,
    response: ServerResponse
) {
    const url = new URL(request.url || '/', 'http://localhost')
    if (url.pathname === '/' && request.method === 'GET') {
        redirectToAgentdWebUi(response)
        return
    }
    if ((url.pathname === '/ui' || url.pathname === '/ui/') && request.method === 'GET') {
        writeAgentdWebUi(response)
        return
    }
    if (url.pathname === '/health' && request.method === 'GET') {
        writeJson(response, 200, {
            ok: true,
            initialized: isInitialized(config, controlPlane)
        })
        return
    }
    if (url.pathname === '/v1/bootstrap/status' && request.method === 'GET') {
        writeJson(response, 200, {
            initialized: isInitialized(config, controlPlane)
        })
        return
    }
    if (url.pathname === '/v1/bootstrap/initialize' && request.method === 'POST') {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        assertTrustedBootstrapOrigin(request)
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['accessKey', 'confirmAccessKey'])
        writeJson(
            response,
            201,
            await controlPlane.initializeAccessKey(
                requiredString(body.accessKey, 'accessKey'),
                requiredString(body.confirmAccessKey, 'confirmAccessKey')
            )
        )
        return
    }
    if (!isInitialized(config, controlPlane)) {
        throw new RequestError(428, 'Gateway setup is required')
    }
    const accessKey = controlPlane?.accessKey?.() || config.authToken
    if (!accessKey) throw new RequestError(500, 'Gateway Access Key is unavailable')
    authenticate(request, accessKey)

    if (url.pathname === '/v1/agents' && request.method === 'GET') {
        writeJson(response, 200, { agents: await sessions.listAgents() })
        return
    }
    if (url.pathname === '/v1/config' && request.method === 'GET') {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        writeJson(response, 200, controlPlane.snapshot())
        return
    }
    if (url.pathname === '/v1/config/workspace-roots' && request.method === 'PUT') {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['workspaceRoots'])
        writeJson(
            response,
            200,
            await controlPlane.putWorkspaceRoots(
                requiredStringArray(body.workspaceRoots, 'workspaceRoots')
            )
        )
        return
    }
    if (url.pathname === '/v1/config/access-key/rotate' && request.method === 'POST') {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        if (Number(request.headers['content-length'] || 0) > 0) {
            const body = await readJsonBody(request, config.maxRequestBytes)
            assertOnlyKeys(body, [])
        }
        writeJson(response, 200, await controlPlane.rotateAccessKey())
        return
    }
    const configAgentMatch = url.pathname.match(/^\/v1\/config\/agents\/([^/]+)$/)
    if (configAgentMatch) {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        const agentId = configAgentMatch[1]
        if (request.method === 'PUT') {
            const body = await readJsonBody(request, config.maxRequestBytes)
            writeJson(
                response,
                200,
                await controlPlane.putAgent(agentId, readAgentUpdate(body))
            )
            return
        }
        if (request.method === 'DELETE') {
            if (Number(request.headers['content-length'] || 0) > 0) {
                const body = await readJsonBody(request, config.maxRequestBytes)
                assertOnlyKeys(body, [])
            }
            writeJson(response, 200, await controlPlane.deleteAgent(agentId))
            return
        }
        throw new RequestError(405, 'Method not allowed')
    }
    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['agentId', 'workspace'])
        const agentId = requiredString(body.agentId, 'agentId')
        const workspace = optionalString(body.workspace)
        writeJson(response, 201, await sessions.create(agentId, workspace))
        return
    }

    const match = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)(?:\/(message|cancel|events))?$/
    )
    if (!match) throw new RequestError(404, 'Route not found')
    const sessionId = decodeURIComponent(match[1])
    const action = match[2]

    if (!action && request.method === 'GET') {
        writeJson(response, 200, sessions.get(sessionId))
        return
    }
    if (action === 'message' && request.method === 'POST') {
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['message'])
        writeJson(
            response,
            202,
            await sessions.message(sessionId, requiredString(body.message, 'message'))
        )
        return
    }
    if (action === 'cancel' && request.method === 'POST') {
        if (Number(request.headers['content-length'] || 0) > 0) {
            const body = await readJsonBody(request, config.maxRequestBytes)
            assertOnlyKeys(body, [])
        }
        writeJson(response, 200, await sessions.cancel(sessionId))
        return
    }
    if (action === 'events' && request.method === 'GET') {
        streamEvents(
            request,
            response,
            sessions,
            sessionId,
            url.searchParams.get('after') ||
                stringHeader(request.headers['last-event-id'])
        )
        return
    }
    throw new RequestError(405, 'Method not allowed')
}

function readAgentUpdate(body: Record<string, unknown>): AgentdAgentUpdate {
    assertOnlyKeys(body, [
        'driver',
        'name',
        'description',
        'enabled',
        'workspace',
        'permissionPolicy',
        'permissionTimeoutMs'
    ])
    const driver = requiredString(body.driver, 'driver') as AgentdDriverKind
    const enabled = optionalBoolean(body.enabled, 'enabled')
    const permissionPolicy = optionalString(body.permissionPolicy) as
        | PermissionPolicy
        | undefined
    const permissionTimeoutMs = optionalNumber(
        body.permissionTimeoutMs,
        'permissionTimeoutMs'
    )
    return {
        driver,
        name: optionalString(body.name),
        description: optionalString(body.description),
        enabled,
        workspace: optionalString(body.workspace),
        permissionPolicy,
        permissionTimeoutMs
    }
}

function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    sessions: SessionManager,
    sessionId: string,
    after?: string
) {
    sessions.get(sessionId)
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    response.flushHeaders?.()
    for (const event of sessions.eventsAfter(sessionId, after)) {
        writeEvent(response, event)
    }
    const unsubscribe = sessions.subscribe(sessionId, (event) =>
        writeEvent(response, event)
    )
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000)
    const close = () => {
        clearInterval(heartbeat)
        unsubscribe()
    }
    request.once('close', close)
    response.once('close', close)
}

function writeEvent(response: ServerResponse, event: AgentdEvent) {
    if (response.destroyed || response.writableEnded) return
    response.write(`id: ${event.id}\n`)
    response.write(`event: ${event.type}\n`)
    response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function authenticate(request: IncomingMessage, expected: string) {
    const value = stringHeader(request.headers.authorization)
    if (!value.startsWith('Bearer ')) {
        throw new RequestError(401, 'Bearer token is required')
    }
    const actual = value.slice(7)
    const left = Buffer.from(actual)
    const right = Buffer.from(expected)
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
        throw new RequestError(401, 'Invalid Bearer token')
    }
}

function isInitialized(
    config: AgentdConfig,
    controlPlane: AgentdControlPlane | undefined
) {
    return controlPlane?.isInitialized?.() ?? config.initialized
}

function assertTrustedBootstrapOrigin(request: IncomingMessage) {
    const origin = stringHeader(request.headers.origin)
    if (!origin) return
    let originHost = ''
    try {
        originHost = new URL(origin).host
    } catch {
        throw new RequestError(403, 'Bootstrap origin is invalid')
    }
    if (!originHost || originHost !== stringHeader(request.headers.host)) {
        throw new RequestError(403, 'Cross-origin Gateway setup is not allowed')
    }
}

function assertJsonContentType(request: IncomingMessage) {
    const contentType = stringHeader(request.headers['content-type'])
        .split(';', 1)[0]
        .trim()
        .toLowerCase()
    if (contentType !== 'application/json') {
        throw new RequestError(415, 'Gateway setup requires application/json')
    }
}

async function readJsonBody(request: IncomingMessage, maxBytes: number) {
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
        throw new RequestError(
            400,
            `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`
        )
    }
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
    const accepted = new Set(allowed)
    const unknown = Object.keys(body).filter((key) => !accepted.has(key))
    if (unknown.length) {
        throw new RequestError(
            400,
            `Unsupported request fields: ${unknown.join(', ')}`
        )
    }
}

function requiredString(value: unknown, name: string) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new RequestError(400, `${name} is required`)
    return text
}

function optionalString(value: unknown) {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'string') throw new RequestError(400, 'Expected a string')
    return value.trim() || undefined
}

function optionalBoolean(value: unknown, name: string) {
    if (value === undefined) return undefined
    if (typeof value !== 'boolean') throw new RequestError(400, `${name} must be boolean`)
    return value
}

function optionalNumber(value: unknown, name: string) {
    if (value === undefined) return undefined
    const number = Number(value)
    if (!Number.isFinite(number)) throw new RequestError(400, `${name} must be a number`)
    return number
}

function requiredStringArray(value: unknown, name: string) {
    if (!Array.isArray(value)) {
        throw new RequestError(400, `${name} must be an array of strings`)
    }
    const result = value.map((item) => {
        if (typeof item !== 'string' || !item.trim()) {
            throw new RequestError(400, `${name} must contain non-empty strings`)
        }
        return item.trim()
    })
    if (!result.length) {
        throw new RequestError(400, `${name} must contain at least one path`)
    }
    return result
}

function stringHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] || '' : value || ''
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
    const body = `${JSON.stringify(value)}\n`
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    })
    response.end(body)
}

class RequestError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message)
    }
}
