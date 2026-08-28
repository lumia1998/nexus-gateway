import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
    ArtifactStoreError,
    contentDisposition,
    GatewayArtifactStore,
    mediaTypeForName
} from './artifact-store.js'
import { AdminSessionStore } from './auth.js'
import {
    ControlPlaneError,
    type AgentdAgentUpdate,
    type AgentdApiKeyUpdate,
    type AgentdRuntimeSettingsUpdate,
    type AgentdControlPlane
} from './control-plane.js'
import {
    RunNotFoundError,
    SessionManager,
    SessionNotFoundError,
    SessionRequestError
} from './session.js'
import type {
    A2AAuthType,
    AgentdApiKeyPrincipal,
    AgentdApiKeyScope,
    AgentdConfig,
    AgentdDriverKind,
    AgentdEvent,
    AgentdArtifact,
    AgentdProtocol,
    AgentdSessionView,
    PermissionPolicy
} from './types.js'
import { redirectToAgentdWebUi, writeAgentdWebUi } from './webui/index.js'
import { WorkspaceFileError, WorkspaceFiles } from './workspace-files.js'

const ADMIN_COOKIE = 'agent_nexus_admin'

export function createAgentdServer(
    config: AgentdConfig,
    sessions: SessionManager,
    controlPlane?: AgentdControlPlane
) {
    const adminSessions = new AdminSessionStore(
        config.adminSessionTtlMs || 12 * 60 * 60 * 1000
    )
    const loginLimiter = new FailureRateLimiter(8, 60_000, 5 * 60_000)
    const apiLimiter = new FailureRateLimiter(30, 60_000, 60_000)
    const artifactStore = new GatewayArtifactStore(
        config.artifactStoragePath || path.resolve('.nexus-agentd-artifacts'),
        config.artifactTtlMs || 24 * 60 * 60 * 1000,
        config.maxArtifactBytes || 512 * 1024 * 1024,
        config.maxArtifactStorageBytes || 4 * 1024 * 1024 * 1024,
        config.maxPublishedArtifacts || 4096,
        config.maxConcurrentArtifactPublishes || 4
    )
    const workspaceFiles = new WorkspaceFiles(
        () => controlPlane?.snapshot().workspaceRoots || config.workspaceRoots,
        config.maxArtifactBytes || 512 * 1024 * 1024
    )
    artifactStore.startCleanup(config.cleanupIntervalMs)
    let sseConnections = 0
    const server = http.createServer((request, response) => {
        const requestId = randomUUID()
        response.setHeader('X-Request-Id', requestId)
        void handleRequest({
            config,
            sessions,
            controlPlane,
            adminSessions,
            loginLimiter,
            apiLimiter,
            artifactStore,
            workspaceFiles,
            request,
            response,
            acquireSse() {
                if (sseConnections >= (config.maxSseConnections || 128)) return false
                sseConnections += 1
                return true
            },
            releaseSse() {
                sseConnections = Math.max(0, sseConnections - 1)
            }
        }).catch((error) => {
            if (response.headersSent) {
                response.destroy(error instanceof Error ? error : undefined)
                return
            }
            const status = errorStatus(error)
            if (status >= 500) {
                console.error(
                    JSON.stringify({
                        level: 'error',
                        event: 'http_request_failed',
                        requestId,
                        method: request.method,
                        path: safePath(request.url),
                        message: errorMessage(error),
                        stack: error instanceof Error ? error.stack : undefined
                    })
                )
            }
            writeJson(response, status, {
                error: status >= 500 ? 'Internal server error' : errorMessage(error),
                requestId
            })
        })
    })
    server.requestTimeout = config.requestTimeoutMs || 30_000
    server.headersTimeout = Math.min(server.requestTimeout, 20_000)
    server.keepAliveTimeout = 5_000
    server.maxConnections = config.maxConnections || 256
    server.once('close', () => {
        adminSessions.clear()
        artifactStore.stopCleanup()
    })
    return server
}

interface RequestContext {
    config: AgentdConfig
    sessions: SessionManager
    controlPlane?: AgentdControlPlane
    adminSessions: AdminSessionStore
    loginLimiter: FailureRateLimiter
    apiLimiter: FailureRateLimiter
    artifactStore: GatewayArtifactStore
    workspaceFiles: WorkspaceFiles
    request: IncomingMessage
    response: ServerResponse
    acquireSse(): boolean
    releaseSse(): void
}

async function handleRequest(context: RequestContext) {
    const {
        config,
        sessions,
        controlPlane,
        adminSessions,
        loginLimiter,
        apiLimiter,
        artifactStore,
        workspaceFiles,
        request,
        response
    } = context
    const url = new URL(request.url || '/', 'http://localhost')

    if (url.pathname === '/' && request.method === 'GET') {
        redirectToAgentdWebUi(response)
        return
    }
    if ((url.pathname === '/ui' || url.pathname === '/ui/') && request.method === 'GET') {
        writeAgentdWebUi(response)
        return
    }
    const artifactMatch = url.pathname.match(
        /^\/v1\/artifacts\/([a-f0-9]{64})\/(\d+)\/([^/]+)$/
    )
    if (artifactMatch && request.method === 'GET') {
        const artifact = await artifactStore.open(
            artifactMatch[1],
            artifactMatch[2],
            decodePathSegment(artifactMatch[3])
        )
        await streamDownload(response, artifact.handle!, artifact.name, artifact.size, artifact.mediaType)
        return
    }
    if (url.pathname === '/health' && request.method === 'GET') {
        writeJson(response, 200, {
            ok: true,
            initialized: isInitialized(config, controlPlane),
            adminSetupRequired: needsAdminSetup(config, controlPlane)
        })
        return
    }
    if (url.pathname === '/v1/bootstrap/status' && request.method === 'GET') {
        writeJson(response, 200, {
            initialized: isInitialized(config, controlPlane),
            adminSetupRequired: needsAdminSetup(config, controlPlane)
        })
        return
    }
    if (url.pathname === '/v1/bootstrap/initialize' && request.method === 'POST') {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        assertJsonContentType(request)
        assertTrustedOrigin(request, true)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['password', 'confirmPassword'])
        writeJson(
            response,
            201,
            await controlPlane.initializeAdminPassword(
                requiredRawString(body.password, 'password'),
                requiredRawString(body.confirmPassword, 'confirmPassword')
            )
        )
        return
    }

    if (url.pathname === '/v1/admin/auth/status' && request.method === 'GET') {
        const id = cookieValue(request, ADMIN_COOKIE)
        writeJson(response, 200, {
            authenticated: Boolean(id && adminSessions.has(id)),
            adminSetupRequired: needsAdminSetup(config, controlPlane)
        })
        return
    }
    if (url.pathname === '/v1/admin/auth/login' && request.method === 'POST') {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        if (needsAdminSetup(config, controlPlane)) {
            throw new RequestError(428, 'Console setup is required')
        }
        assertJsonContentType(request)
        assertTrustedOrigin(request, true)
        const rateKey = remoteKey(request)
        loginLimiter.assertAllowed(rateKey)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['password'])
        const password = requiredRawString(body.password, 'password')
        if (!(await controlPlane.verifyAdminPassword(password))) {
            loginLimiter.failure(rateKey)
            throw new RequestError(401, 'Invalid Console Password')
        }
        loginLimiter.success(rateKey)
        const sessionId = adminSessions.create()
        response.setHeader(
            'Set-Cookie',
            adminCookie(sessionId, config.adminSessionTtlMs || 12 * 60 * 60 * 1000, config)
        )
        writeJson(response, 200, { authenticated: true })
        return
    }
    if (url.pathname === '/v1/admin/auth/logout' && request.method === 'POST') {
        assertTrustedOrigin(request, true)
        const id = cookieValue(request, ADMIN_COOKIE)
        if (id) adminSessions.delete(id)
        response.setHeader('Set-Cookie', clearAdminCookie(config))
        writeJson(response, 200, { authenticated: false })
        return
    }

    if (!isInitialized(config, controlPlane)) {
        throw new RequestError(428, 'Gateway setup is required')
    }

    if (url.pathname.startsWith('/v1/admin/')) {
        if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')
        authenticateAdmin(request, adminSessions)
        if (isMutating(request.method)) assertTrustedOrigin(request, true)
        await handleAdminRoute(context, url)
        return
    }

    const principal = authenticateApiKey(request, config, controlPlane, apiLimiter)
    if (url.pathname === '/v1/agents' && request.method === 'GET') {
        const ids = principal.scope.allAgents
            ? undefined
            : new Set(principal.scope.agentIds)
        writeJson(response, 200, {
            agents: await sessions.listAgents(ids, url.searchParams.get('refresh') === '1')
        })
        return
    }
    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['agentId', 'workspace'])
        const agentId = requiredString(body.agentId, 'agentId')
        assertAgentScope(principal, agentId)
        writeJson(
            response,
            201,
            await materializeSessionArtifacts(
                await sessions.create(agentId, optionalString(body.workspace), principal.id),
                artifactStore
            )
        )
        return
    }

    const filesMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/files(?:\/(content|publish))?$/
    )
    if (filesMatch) {
        const sessionId = decodePathSegment(filesMatch[1])
        const session = ownedSession(sessions, sessionId, principal)
        const root = await workspaceFiles.sessionRoot(session.workspace)
        const action = filesMatch[2]
        if (!action && request.method === 'GET') {
            writeJson(response, 200, await workspaceFiles.list(root, url.searchParams.get('path') || ''))
            return
        }
        if (action === 'content' && request.method === 'GET') {
            const file = await workspaceFiles.open(root, requiredQuery(url, 'path'))
            await streamDownload(response, file.handle, file.name, file.size, mediaTypeForName(file.name))
            return
        }
        if (action === 'publish' && request.method === 'POST') {
            assertJsonContentType(request)
            const body = await readJsonBody(request, config.maxRequestBytes)
            assertOnlyKeys(body, ['paths'])
            const paths = requiredStringArray(body.paths, 'paths')
            if (paths.length > 32) throw new RequestError(400, 'paths must contain at most 32 values')
            const result = await publishWorkspaceFiles(
                workspaceFiles,
                artifactStore,
                root,
                paths
            )
            writeJson(response, result.errors.length ? 207 : 201, result)
            return
        }
        throw new RequestError(405, 'Method not allowed')
    }

    const attachmentMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attachments$/)
    if (attachmentMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(attachmentMatch[1])
        const session = sessions.get(sessionId)
        if (!sessions.owns(sessionId, principal.id)) {
            throw new RequestError(404, 'Session not found')
        }
        assertAgentScope(principal, session.agentId)
        const bytes = await readBytesBody(
            request,
            config.maxAttachmentBytes || 32 * 1024 * 1024
        )
        writeJson(
            response,
            201,
            sessions.addInputAttachment(
                sessionId,
                decodeHeader(request.headers['x-nexus-file-name']) || 'attachment',
                normalizedMediaType(request.headers['content-type']),
                bytes
            )
        )
        return
    }

    const match = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)(?:\/(message|cancel|events))?$/
    )
    if (!match) throw new RequestError(404, 'Route not found')
    const sessionId = decodeURIComponent(match[1])
    const action = match[2]
    const session = sessions.get(sessionId)
    if (!sessions.owns(sessionId, principal.id)) {
        throw new RequestError(404, 'Session not found')
    }
    assertAgentScope(principal, session.agentId)

    if (!action && request.method === 'GET') {
        writeJson(response, 200, await materializeSessionArtifacts(session, artifactStore))
        return
    }
    if (action === 'message' && request.method === 'POST') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['message', 'attachments'])
        writeJson(
            response,
            202,
            await materializeSessionArtifacts(
                await sessions.message(
                    sessionId,
                    requiredMessage(body.message),
                    optionalAttachmentIds(body.attachments)
                ),
                artifactStore
            )
        )
        return
    }
    if (action === 'cancel' && request.method === 'POST') {
        await assertEmptyJsonBody(request, config.maxRequestBytes)
        writeJson(
            response,
            200,
            await materializeSessionArtifacts(await sessions.cancel(sessionId), artifactStore)
        )
        return
    }
    if (action === 'events' && request.method === 'GET') {
        if (!context.acquireSse()) {
            throw new RequestError(429, 'SSE connection capacity has been reached')
        }
        streamEvents(
            request,
            response,
            sessions,
            sessionId,
            url.searchParams.get('after') || stringHeader(request.headers['last-event-id']),
            context.releaseSse
        )
        return
    }
    throw new RequestError(405, 'Method not allowed')
}

async function handleAdminRoute(context: RequestContext, url: URL) {
    const {
        config,
        sessions,
        controlPlane,
        adminSessions,
        artifactStore,
        workspaceFiles,
        request,
        response
    } = context
    if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')

    if (url.pathname === '/v1/admin/files/roots' && request.method === 'GET') {
        writeJson(response, 200, { roots: await workspaceFiles.roots() })
        return
    }
    if (url.pathname === '/v1/admin/files' && request.method === 'GET') {
        const root = await workspaceFiles.adminRoot(requiredQuery(url, 'root'))
        writeJson(response, 200, await workspaceFiles.list(root, url.searchParams.get('path') || ''))
        return
    }
    if (url.pathname === '/v1/admin/files/content') {
        const root = await workspaceFiles.adminRoot(requiredQuery(url, 'root'))
        const filePath = requiredQuery(url, 'path')
        if (request.method === 'GET') {
            const file = await workspaceFiles.open(root, filePath)
            await streamDownload(response, file.handle, file.name, file.size, mediaTypeForName(file.name))
            return
        }
        if (request.method === 'PUT') {
            const declared = optionalContentLength(request)
            writeJson(response, 201, await workspaceFiles.write(root, filePath, request, declared))
            return
        }
        if (request.method === 'DELETE') {
            await assertEmptyJsonBody(request, config.maxRequestBytes)
            writeJson(response, 200, await workspaceFiles.remove(root, filePath))
            return
        }
        throw new RequestError(405, 'Method not allowed')
    }
    if (url.pathname === '/v1/admin/files/directory' && request.method === 'POST') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['root', 'path'])
        const root = await workspaceFiles.adminRoot(requiredString(body.root, 'root'))
        writeJson(response, 201, await workspaceFiles.createDirectory(root, requiredString(body.path, 'path')))
        return
    }
    if (url.pathname === '/v1/admin/files/move' && request.method === 'POST') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['root', 'path', 'destination'])
        const root = await workspaceFiles.adminRoot(requiredString(body.root, 'root'))
        writeJson(
            response,
            200,
            await workspaceFiles.move(
                root,
                requiredString(body.path, 'path'),
                requiredString(body.destination, 'destination')
            )
        )
        return
    }
    if (url.pathname === '/v1/admin/files/publish' && request.method === 'POST') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['root', 'paths'])
        const root = await workspaceFiles.adminRoot(requiredString(body.root, 'root'))
        const paths = requiredStringArray(body.paths, 'paths')
        if (paths.length > 32) throw new RequestError(400, 'paths must contain at most 32 values')
        const result = await publishWorkspaceFiles(
            workspaceFiles,
            artifactStore,
            root,
            paths
        )
        writeJson(response, result.errors.length ? 207 : 201, result)
        return
    }

    if (url.pathname === '/v1/admin/overview' && request.method === 'GET') {
        const agents = await sessions.listAgents(undefined, url.searchParams.get('refresh') === '1')
        writeJson(response, 200, { agents, sessions: sessions.count() })
        return
    }
    if (url.pathname === '/v1/admin/config' && request.method === 'GET') {
        writeJson(response, 200, controlPlane.snapshot())
        return
    }
    if (url.pathname === '/v1/admin/agents' && request.method === 'GET') {
        writeJson(response, 200, {
            agents: await sessions.listAgents(undefined, url.searchParams.get('refresh') === '1'),
            config: controlPlane.snapshot().agents
        })
        return
    }
    if (url.pathname === '/v1/admin/runs' && request.method === 'GET') {
        const state = optionalRunState(url.searchParams.get('state'))
        writeJson(
            response,
            200,
            sessions.listRuns({
                agentId: cleanQuery(url.searchParams.get('agentId')),
                sessionId: cleanQuery(url.searchParams.get('sessionId')),
                state,
                query: cleanQuery(url.searchParams.get('q')),
                limit: boundedLimit(url.searchParams.get('limit'))
            })
        )
        return
    }
    const runMatch = url.pathname.match(/^\/v1\/admin\/runs\/([^/]+)$/)
    if (runMatch && request.method === 'GET') {
        writeJson(response, 200, sessions.getRun(decodeURIComponent(runMatch[1])))
        return
    }
    if (url.pathname === '/v1/admin/config/workspace-roots' && request.method === 'PUT') {
        assertJsonContentType(request)
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
    if (url.pathname === '/v1/admin/config/runtime' && request.method === 'PUT') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['sessionTtlMs', 'promptTimeoutMs', 'cleanupIntervalMs'])
        writeJson(
            response,
            200,
            await controlPlane.putRuntimeSettings(readRuntimeSettingsUpdate(body))
        )
        return
    }
    if (url.pathname === '/v1/admin/password' && request.method === 'PUT') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['currentPassword', 'newPassword', 'confirmPassword'])
        const result = await controlPlane.changeAdminPassword(
            requiredRawString(body.currentPassword, 'currentPassword'),
            requiredRawString(body.newPassword, 'newPassword'),
            requiredRawString(body.confirmPassword, 'confirmPassword')
        )
        adminSessions.clear()
        response.setHeader('Set-Cookie', clearAdminCookie(config))
        writeJson(response, 200, result)
        return
    }
    if (url.pathname === '/v1/admin/api-keys') {
        if (request.method === 'GET') {
            writeJson(response, 200, { apiKeys: controlPlane.listApiKeys() })
            return
        }
        if (request.method === 'POST') {
            assertJsonContentType(request)
            const body = await readJsonBody(request, config.maxRequestBytes)
            assertOnlyKeys(body, ['name', 'scope', 'customSecret'])
            writeJson(
                response,
                201,
                await controlPlane.createApiKey(
                    requiredString(body.name, 'name'),
                    readApiKeyScope(body.scope),
                    optionalRawString(body.customSecret, 'customSecret')
                )
            )
            return
        }
    }
    const keyMatch = url.pathname.match(
        /^\/v1\/admin\/api-keys\/([^/]+)(?:\/(reveal|regenerate))?$/
    )
    if (keyMatch) {
        const id = keyMatch[1]
        const action = keyMatch[2]
        if (action === 'reveal' && request.method === 'POST') {
            await assertEmptyJsonBody(request, config.maxRequestBytes)
            writeJson(response, 200, controlPlane.revealApiKey(id))
            return
        }
        if (action === 'regenerate' && request.method === 'POST') {
            await assertEmptyJsonBody(request, config.maxRequestBytes)
            writeJson(response, 200, await controlPlane.regenerateApiKey(id))
            return
        }
        if (!action && request.method === 'PATCH') {
            assertJsonContentType(request)
            const body = await readJsonBody(request, config.maxRequestBytes)
            writeJson(response, 200, await controlPlane.updateApiKey(id, readApiKeyUpdate(body)))
            return
        }
        if (!action && request.method === 'DELETE') {
            await assertEmptyJsonBody(request, config.maxRequestBytes)
            writeJson(response, 200, await controlPlane.deleteApiKey(id))
            return
        }
        throw new RequestError(405, 'Method not allowed')
    }
    const agentMatch = url.pathname.match(/^\/v1\/admin\/agents\/([^/]+)$/)
    if (agentMatch) {
        if (request.method === 'PUT') {
            assertJsonContentType(request)
            const body = await readJsonBody(request, config.maxRequestBytes)
            writeJson(response, 200, await controlPlane.putAgent(agentMatch[1], readAgentUpdate(body)))
            return
        }
        if (request.method === 'DELETE') {
            await assertEmptyJsonBody(request, config.maxRequestBytes)
            writeJson(response, 200, await controlPlane.deleteAgent(agentMatch[1]))
            return
        }
        throw new RequestError(405, 'Method not allowed')
    }
    throw new RequestError(404, 'Route not found')
}

function readAgentUpdate(body: Record<string, unknown>): AgentdAgentUpdate {
    assertOnlyKeys(body, [
        'protocol',
        'driver',
        'name',
        'description',
        'instructions',
        'enabled',
        'workspace',
        'permissionPolicy',
        'permissionTimeoutMs',
        'agentCardUrl',
        'agentUrl',
        'preferredTransport',
        'authType',
        'authValue',
        'authHeaderName',
        'timeoutMs'
    ])
    return {
        protocol: requiredString(body.protocol, 'protocol') as AgentdProtocol,
        driver: optionalString(body.driver) as AgentdDriverKind | undefined,
        name: optionalString(body.name),
        description: optionalString(body.description),
        instructions: optionalString(body.instructions),
        enabled: optionalBoolean(body.enabled, 'enabled'),
        workspace: optionalString(body.workspace),
        permissionPolicy: optionalString(body.permissionPolicy) as PermissionPolicy | undefined,
        permissionTimeoutMs: optionalNumber(body.permissionTimeoutMs, 'permissionTimeoutMs'),
        agentCardUrl: optionalString(body.agentCardUrl),
        agentUrl: optionalString(body.agentUrl),
        preferredTransport: optionalString(body.preferredTransport) as AgentdAgentUpdate['preferredTransport'],
        authType: optionalString(body.authType) as A2AAuthType | undefined,
        authValue: optionalRawString(body.authValue, 'authValue'),
        authHeaderName: optionalString(body.authHeaderName),
        timeoutMs: optionalNumber(body.timeoutMs, 'timeoutMs')
    }
}

function readRuntimeSettingsUpdate(body: Record<string, unknown>): AgentdRuntimeSettingsUpdate {
    return {
        sessionTtlMs: requiredInteger(body.sessionTtlMs, 'sessionTtlMs'),
        promptTimeoutMs: requiredInteger(body.promptTimeoutMs, 'promptTimeoutMs'),
        cleanupIntervalMs: requiredInteger(body.cleanupIntervalMs, 'cleanupIntervalMs')
    }
}

function readApiKeyUpdate(body: Record<string, unknown>): AgentdApiKeyUpdate {
    assertOnlyKeys(body, ['name', 'enabled', 'scope'])
    return {
        name: optionalString(body.name),
        enabled: optionalBoolean(body.enabled, 'enabled'),
        scope: body.scope === undefined ? undefined : readApiKeyScope(body.scope)
    }
}

function readApiKeyScope(value: unknown): AgentdApiKeyScope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new RequestError(400, 'scope must be an object')
    }
    const scope = value as Record<string, unknown>
    assertOnlyKeys(scope, ['allAgents', 'agentIds'])
    if (typeof scope.allAgents !== 'boolean') {
        throw new RequestError(400, 'scope.allAgents must be boolean')
    }
    return {
        allAgents: scope.allAgents,
        agentIds: requiredStringArray(scope.agentIds ?? [], 'scope.agentIds', true)
    }
}

function streamEvents(
    request: IncomingMessage,
    response: ServerResponse,
    sessions: SessionManager,
    sessionId: string,
    after: string | undefined,
    release: () => void
) {
    response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    response.flushHeaders?.()
    for (const event of sessions.eventsAfter(sessionId, after)) writeEvent(response, event)
    const unsubscribe = sessions.subscribe(sessionId, (event) => writeEvent(response, event))
    const heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n')
    }, 15_000)
    heartbeat.unref?.()
    let closed = false
    const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
        release()
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

function authenticateAdmin(request: IncomingMessage, sessions: AdminSessionStore) {
    const id = cookieValue(request, ADMIN_COOKIE)
    if (!id || !sessions.has(id)) throw new RequestError(401, 'Admin session is required')
}

function authenticateApiKey(
    request: IncomingMessage,
    config: AgentdConfig,
    controlPlane: AgentdControlPlane | undefined,
    limiter: FailureRateLimiter
): AgentdApiKeyPrincipal {
    const rateKey = remoteKey(request)
    limiter.assertAllowed(rateKey)
    const value = stringHeader(request.headers.authorization)
    if (!value.startsWith('Bearer ')) {
        limiter.failure(rateKey)
        throw new RequestError(401, 'Bearer API Key is required')
    }
    const secret = value.slice(7)
    const authenticate = (controlPlane as any)?.authenticateApiKey
    const principal =
        (typeof authenticate === 'function'
            ? authenticate.call(controlPlane, secret)
            : undefined) || fallbackApiKey(config, secret)
    if (!principal) {
        limiter.failure(rateKey)
        throw new RequestError(401, 'Invalid API Key')
    }
    limiter.success(rateKey)
    return principal
}

function fallbackApiKey(config: AgentdConfig, secret: string): AgentdApiKeyPrincipal | undefined {
    for (const key of config.apiKeys || []) {
        if (key.enabled && safeEqual(key.secret, secret)) {
            return { id: key.id, scope: structuredClone(key.scope) }
        }
    }
    if (config.authToken && safeEqual(config.authToken, secret)) {
        return { id: 'legacy', scope: { allAgents: true, agentIds: [] } }
    }
    return undefined
}

function assertAgentScope(principal: AgentdApiKeyPrincipal, agentId: string) {
    if (!principal.scope.allAgents && !principal.scope.agentIds.includes(agentId)) {
        throw new RequestError(403, 'API Key is not authorized for this agent')
    }
}

function isInitialized(config: AgentdConfig, controlPlane?: AgentdControlPlane) {
    return controlPlane?.isInitialized() ?? config.initialized
}

function needsAdminSetup(config: AgentdConfig, controlPlane?: AgentdControlPlane) {
    const value = (controlPlane as any)?.needsAdminSetup
    return typeof value === 'function' ? value.call(controlPlane) : !config.adminPasswordHash
}

function assertTrustedOrigin(request: IncomingMessage, required: boolean) {
    const origin = stringHeader(request.headers.origin)
    if (!origin) {
        if (required) throw new RequestError(403, 'Same-origin request is required')
        return
    }
    let originHost = ''
    try {
        originHost = new URL(origin).host
    } catch {
        throw new RequestError(403, 'Request origin is invalid')
    }
    if (!originHost || originHost !== stringHeader(request.headers.host)) {
        throw new RequestError(403, 'Cross-origin admin request is not allowed')
    }
}

function assertJsonContentType(request: IncomingMessage) {
    const contentType = stringHeader(request.headers['content-type'])
        .split(';', 1)[0]
        .trim()
        .toLowerCase()
    if (contentType !== 'application/json') {
        throw new RequestError(415, 'Request requires application/json')
    }
}

async function assertEmptyJsonBody(request: IncomingMessage, maxBytes: number) {
    if (Number(request.headers['content-length'] || 0) <= 0) return
    assertJsonContentType(request)
    const body = await readJsonBody(request, maxBytes)
    assertOnlyKeys(body, [])
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
        throw new RequestError(400, `Invalid JSON body: ${errorMessage(error)}`)
    }
}

async function readBytesBody(request: IncomingMessage, maxBytes: number) {
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

function assertOnlyKeys(body: Record<string, unknown>, allowed: string[]) {
    const accepted = new Set(allowed)
    const unknown = Object.keys(body).filter((key) => !accepted.has(key))
    if (unknown.length) {
        throw new RequestError(400, `Unsupported request fields: ${unknown.join(', ')}`)
    }
}

function requiredString(value: unknown, name: string) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text) throw new RequestError(400, `${name} is required`)
    return text
}

function requiredRawString(value: unknown, name: string) {
    if (typeof value !== 'string' || !value) throw new RequestError(400, `${name} is required`)
    return value
}

function requiredMessage(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new RequestError(400, 'message is required')
    }
    return value
}

function requiredInteger(value: unknown, name: string) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new RequestError(400, `${name} must be an integer`)
    }
    return value
}

function optionalAttachmentIds(value: unknown) {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 16) {
        throw new RequestError(400, 'attachments must be an array with at most 16 ids')
    }
    return value.map((item) => requiredString(item, 'attachments'))
}

function normalizedMediaType(value: string | string[] | undefined) {
    const mediaType = stringHeader(value).split(';', 1)[0].trim().toLowerCase()
    return mediaType || undefined
}

function decodeHeader(value: string | string[] | undefined) {
    const raw = stringHeader(value)
    if (!raw) return ''
    try {
        return decodeURIComponent(raw)
    } catch {
        return raw
    }
}

function cleanQuery(value: string | null) {
    const text = String(value || '').trim()
    return text || undefined
}

function boundedLimit(value: string | null) {
    if (!value) return undefined
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1 || number > 200) {
        throw new RequestError(400, 'limit must be an integer between 1 and 200')
    }
    return number
}

function optionalRunState(value: string | null) {
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
    return value as import('./types.js').AgentdSessionState
}

function optionalRawString(value: unknown, name: string) {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string') throw new RequestError(400, `${name} must be a string`)
    return value
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
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new RequestError(400, `${name} must be an integer`)
    }
    return value
}

function requiredStringArray(value: unknown, name: string, allowEmpty = false) {
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

function requiredQuery(url: URL, name: string) {
    const value = url.searchParams.get(name)?.trim()
    if (!value) throw new RequestError(400, `${name} is required`)
    return value
}

function optionalContentLength(request: IncomingMessage) {
    const raw = stringHeader(request.headers['content-length'])
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RequestError(400, 'Content-Length is invalid')
    }
    return value
}

function cookieValue(request: IncomingMessage, name: string) {
    const cookie = stringHeader(request.headers.cookie)
    for (const part of cookie.split(';')) {
        const index = part.indexOf('=')
        if (index < 0 || part.slice(0, index).trim() !== name) continue
        return part.slice(index + 1).trim()
    }
    return ''
}

function adminCookie(value: string, ttlMs: number, config: AgentdConfig) {
    return [
        `${ADMIN_COOKIE}=${value}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(ttlMs / 1000)}`,
        ...(config.secureAdminCookies ? ['Secure'] : [])
    ].join('; ')
}

function clearAdminCookie(config: AgentdConfig) {
    return [
        `${ADMIN_COOKIE}=`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        'Max-Age=0',
        ...(config.secureAdminCookies ? ['Secure'] : [])
    ].join('; ')
}

function isMutating(method?: string) {
    return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}

function remoteKey(request: IncomingMessage) {
    return request.socket.remoteAddress || 'unknown'
}

function stringHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] || '' : value || ''
}

function safeEqual(left: string, right: string) {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    return a.length === b.length && timingSafeEqual(a, b)
}

function safePath(value?: string) {
    try {
        return new URL(value || '/', 'http://localhost').pathname
    } catch {
        return '/invalid-url'
    }
}

function decodePathSegment(value: string) {
    try {
        return decodeURIComponent(value)
    } catch {
        throw new RequestError(400, 'URL path is invalid')
    }
}

function ownedSession(
    sessions: SessionManager,
    sessionId: string,
    principal: AgentdApiKeyPrincipal
) {
    const session = sessions.get(sessionId)
    if (!sessions.owns(sessionId, principal.id)) {
        throw new RequestError(404, 'Session not found')
    }
    assertAgentScope(principal, session.agentId)
    return session
}

async function streamDownload(
    response: ServerResponse,
    handle: FileHandle,
    name: string,
    size: number,
    mediaType: string
) {
    try {
        response.writeHead(200, {
            'Content-Type': mediaType,
            'Content-Length': size,
            'Content-Disposition': contentDisposition(name),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'
        })
        await pipeline(handle.createReadStream({ autoClose: false }), response)
    } finally {
        await handle.close().catch(() => undefined)
    }
}

async function publishWorkspaceFiles(
    workspaceFiles: WorkspaceFiles,
    artifactStore: GatewayArtifactStore,
    root: string,
    paths: string[]
) {
    const files = []
    const errors: Array<{ path: string; error: string }> = []
    let firstFailure: { status: number; message: string } | undefined
    for (const value of paths) {
        let file: Awaited<ReturnType<WorkspaceFiles['publishable']>> | undefined
        try {
            file = await workspaceFiles.publishable(root, value)
            files.push(await artifactStore.publishHandle(file.handle, file.name))
        } catch (error) {
            if (!(error instanceof WorkspaceFileError) && !(error instanceof ArtifactStoreError)) {
                throw error
            }
            firstFailure ||= { status: error.status, message: error.message }
            errors.push({ path: value, error: error.message })
        } finally {
            await file?.handle.close().catch(() => undefined)
        }
    }
    if (!files.length && firstFailure) {
        throw new RequestError(firstFailure.status, firstFailure.message)
    }
    return { files, errors }
}

async function materializeSessionArtifacts(
    session: AgentdSessionView,
    store: GatewayArtifactStore
): Promise<AgentdSessionView> {
    const artifacts = await Promise.all(
        session.artifacts.map(async (artifact, index): Promise<AgentdArtifact> => {
            if (!artifact.bytesBase64) return artifact
            let bytes: Buffer
            try {
                bytes = decodeArtifactBase64(artifact.bytesBase64)
            } catch (error) {
                return omittedArtifact(artifact, errorMessage(error))
            }
            try {
                const published = await store.publishBytes(
                    bytes,
                    artifact.filename || artifact.name || `artifact-${artifact.id || randomUUID()}`,
                    artifact.mediaType,
                    `${session.id}:${artifact.id || index}`
                )
                return {
                    ...artifact,
                    name: artifact.name || published.name,
                    filename: artifact.filename || published.name,
                    url: published.url,
                    bytesBase64: undefined,
                    metadata: {
                        ...artifact.metadata,
                        publishedArtifactId: published.id,
                        size: published.size,
                        sha256: published.sha256,
                        expiresAt: published.expiresAt
                    }
                }
            } catch (error) {
                if (error instanceof ArtifactStoreError && error.status === 413) {
                    return omittedArtifact(artifact, error.message)
                }
                throw error
            }
        })
    )
    return { ...session, artifacts }
}

function decodeArtifactBase64(value: string) {
    const normalized = value.replace(/\s/g, '')
    if (
        !normalized ||
        normalized.length % 4 === 1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)
    ) {
        throw new Error('Artifact contains invalid Base64 data')
    }
    const bytes = Buffer.from(normalized, 'base64')
    if (bytes.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
        throw new Error('Artifact contains invalid Base64 data')
    }
    return bytes
}

function omittedArtifact(artifact: AgentdArtifact, reason: string): AgentdArtifact {
    return {
        ...artifact,
        bytesBase64: undefined,
        description: [artifact.description, `[binary artifact omitted: ${reason}]`]
            .filter(Boolean)
            .join('\n')
    }
}

function errorStatus(error: unknown) {
    if (error instanceof RunNotFoundError) return 404
    if (error instanceof SessionNotFoundError) return 404
    if (error instanceof SessionRequestError) return error.status
    if (error instanceof ControlPlaneError) return error.status
    if (error instanceof ArtifactStoreError) return error.status
    if (error instanceof WorkspaceFileError) return error.status
    if (error instanceof RequestError) return error.status
    return 500
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error)
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
    const body = `${JSON.stringify(value)}\n`
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
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

class FailureRateLimiter {
    private readonly entries = new Map<
        string,
        { count: number; windowStartedAt: number; blockedUntil: number }
    >()

    constructor(
        private readonly maximum: number,
        private readonly windowMs: number,
        private readonly blockMs: number
    ) {}

    assertAllowed(key: string) {
        const entry = this.entries.get(key)
        if (entry?.blockedUntil && entry.blockedUntil > Date.now()) {
            throw new RequestError(429, 'Too many authentication attempts')
        }
    }

    failure(key: string) {
        const now = Date.now()
        const previous = this.entries.get(key)
        const entry =
            !previous || now - previous.windowStartedAt >= this.windowMs
                ? { count: 0, windowStartedAt: now, blockedUntil: 0 }
                : previous
        entry.count += 1
        if (entry.count >= this.maximum) entry.blockedUntil = now + this.blockMs
        this.entries.set(key, entry)
    }

    success(key: string) {
        this.entries.delete(key)
    }
}
