import { randomUUID } from 'node:crypto'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { AdminSessionStore } from './auth.js'
import { streamSessionEvents } from './server/connection.js'
import {
    DiagnosticConcurrencyError,
    DiagnosticRunner
} from './server/diagnostics.js'
import {
    ADMIN_COOKIE,
    adminCookie,
    assertAgentScope,
    assertConsoleHost,
    assertTrustedOrigin,
    authenticateAdmin,
    authenticateApiKey,
    clearAdminCookie,
    cookieValue,
    isInitialized,
    isMutating,
    needsAdminSetup,
    remoteKey,
    stringHeader
} from './server/auth-policy.js'
import { GatewayMetrics } from './server/metrics.js'
import { QuotaExceededError, QuotaManager } from './server/quota.js'
import {
    RequestError,
    assertEmptyJsonBody,
    assertJsonContentType,
    assertOnlyKeys,
    boundedLimit,
    cleanQuery,
    decodeHeader,
    normalizePublishPaths,
    normalizedMediaType,
    optionalAttachmentIds,
    optionalBoolean,
    optionalNumber,
    optionalPendingAction,
    optionalRawString,
    optionalRunState,
    optionalString,
    readBytesBody,
    readJsonBody,
    requiredInteger,
    requiredMessage,
    requiredRawString,
    requiredString,
    requiredStringArray
} from './server/validation.js'
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
    AdminRetryReservation,
    AdminRetryReservationFactory
} from './session/admin-runs.js'
import type { ArtifactReadResult } from './run-store.js'
import type {
    A2AAuthType,
    AgentdApiKeyScope,
    AgentdConfig,
    AgentdDriverKind,
    AgentdPendingResponse,
    AgentdProtocol,
    PermissionPolicy
} from './types.js'
import { redirectToAgentdWebUi, writeAgentdWebUi, writeAgentdWebUiModule } from './webui/index.js'

export { QuotaExceededError, QuotaManager, quotaLimitsFromConfig } from './server/quota.js'
export { DiagnosticRunner, DiagnosticConcurrencyError } from './server/diagnostics.js'
export { GatewayMetrics } from './server/metrics.js'

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
    const setupLimiter = new FailureRateLimiter(8, 60_000, 60_000)
    const revealLimiter = new FailureRateLimiter(20, 60_000, 60_000)
    const quota = new QuotaManager(config)
    const metrics = new GatewayMetrics()
    const diagnostics = new DiagnosticRunner(2)
    let sseConnections = 0
    const sessionReservations = new Map<string, () => void>()
    const uploadReservations = new Map<string, () => void>()
    const runReservations = new Map<string, () => void>()
    // SessionManager emits terminal run transitions independently of HTTP
    // requests. Release the per-key running slot at that boundary so an
    // asynchronous completion cannot strand a quota reservation until the
    // next poll.
    const releaseRunReservationById = (sessionId: string) => {
        const release = runReservations.get(sessionId)
        if (release) release()
        else quota.finishRun(sessionId)
    }
    const releaseSessionReservationsById = (sessionId: string) => {
        const releaseSession = sessionReservations.get(sessionId)
        if (releaseSession) {
            sessionReservations.delete(sessionId)
            releaseSession()
        }
        const releaseUpload = uploadReservations.get(sessionId)
        if (releaseUpload) {
            uploadReservations.delete(sessionId)
            releaseUpload()
        }
        releaseRunReservationById(sessionId)
    }
    const subscribeLifecycle = (sessions as unknown as {
        subscribeLifecycle?: (listener: (event: {
            type: string
            sessionId: string
            state?: string
        }) => void) => (() => void)
    }).subscribeLifecycle
    const unsubscribeLifecycle = typeof subscribeLifecycle === 'function'
        ? subscribeLifecycle.call(sessions, (event) => {
            if (event.type === 'run_updated' && event.state && isTerminalState(event.state)) {
                releaseRunReservationById(event.sessionId)
            }
            if (event.type === 'session_closed') {
                releaseSessionReservationsById(event.sessionId)
            }
        })
        : undefined
    const server = http.createServer((request, response) => {
        const requestId = randomUUID()
        metrics.requestStarted()
        response.setHeader('X-Request-Id', requestId)
        response.once('finish', () => {
            metrics.responseFinished(response.statusCode, response.statusCode === 429)
        })
        void handleRequest({
            config,
            sessions,
            controlPlane,
            adminSessions,
            loginLimiter,
            apiLimiter,
            setupLimiter,
            revealLimiter,
            quota,
            metrics,
            diagnostics,
            sessionReservations,
            uploadReservations,
            runReservations,
            currentSse: () => sseConnections,
            request,
            response,
            acquireSse(keyId: string) {
                if (sseConnections >= (config.maxSseConnections || 128)) {
                    throw new QuotaExceededError(
                        'sse',
                        config.maxSseConnections || 128,
                        sseConnections,
                        1_000
                    )
                }
                const releaseQuota = quota.reserveSse(keyId)
                sseConnections += 1
                return () => {
                    releaseQuota()
                    sseConnections = Math.max(0, sseConnections - 1)
                }
            },
        }).catch((error) => {
            if (response.headersSent) {
                response.destroy(error instanceof Error ? error : undefined)
                return
            }
            const status = errorStatus(error)
            if (error instanceof QuotaExceededError || error instanceof DiagnosticConcurrencyError) {
                const retryAfterMs = error.retryAfterMs
                response.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
                response.setHeader('X-Quota-Type', error instanceof QuotaExceededError ? error.quota : 'diagnostics')
            }
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
            writeError(response, status, error, requestId)
        })
    })
    server.requestTimeout = config.requestTimeoutMs || 30_000
    server.headersTimeout = Math.min(server.requestTimeout, 20_000)
    server.keepAliveTimeout = 5_000
    server.maxConnections = config.maxConnections || 256
    server.once('close', () => {
        unsubscribeLifecycle?.()
        for (const sessionId of new Set([
            ...sessionReservations.keys(),
            ...uploadReservations.keys(),
            ...runReservations.keys()
        ])) {
            releaseSessionReservationsById(sessionId)
        }
        adminSessions.clear()
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
    setupLimiter: FailureRateLimiter
    revealLimiter: FailureRateLimiter
    quota: QuotaManager
    metrics: GatewayMetrics
    diagnostics: DiagnosticRunner
    sessionReservations: Map<string, () => void>
    uploadReservations: Map<string, () => void>
    runReservations: Map<string, () => void>
    currentSse(): number
    request: IncomingMessage
    response: ServerResponse
    acquireSse(keyId: string): (() => void) | false
}

async function handleRequest(context: RequestContext) {
    const {
        config,
        sessions,
        controlPlane,
        adminSessions,
        loginLimiter,
        apiLimiter,
        request,
        response
    } = context
    const url = new URL(request.url || '/', 'http://localhost')
    if (url.pathname === '/' || url.pathname.startsWith('/ui') || url.pathname.startsWith('/v1/admin/') || url.pathname.startsWith('/v1/bootstrap/')) {
        assertConsoleHost(request, config)
    }

    if (url.pathname === '/' && request.method === 'GET') {
        redirectToAgentdWebUi(response)
        return
    }
    if ((url.pathname === '/ui' || url.pathname === '/ui/') && request.method === 'GET') {
        writeAgentdWebUi(response)
        return
    }
    if (url.pathname.startsWith('/ui/') && request.method === 'GET') {
        writeAgentdWebUiModule(response, url.pathname)
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
        assertTrustedOrigin(request, config)
        if (!needsAdminSetup(config, controlPlane)) throw new RequestError(409, 'Console setup is already complete')
        const rateKey = remoteKey(request)
        context.setupLimiter.assertAllowed(rateKey)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['password', 'confirmPassword', 'setupToken'])
        if (!controlPlane.verifySetupToken(optionalRawString(body.setupToken, 'setupToken') || '')) {
            context.setupLimiter.failure(rateKey)
            throw new RequestError(403, 'Invalid setup token')
        }
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
        assertTrustedOrigin(request, config)
        const rateKey = remoteKey(request)
        loginLimiter.assertAllowed(rateKey)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['password'])
        const password = requiredRawString(body.password, 'password')
        // Reserve the attempt before asynchronous scrypt, including concurrent requests.
        loginLimiter.assertAllowed(rateKey)
        loginLimiter.failure(rateKey)
        if (!(await controlPlane.verifyAdminPassword(password))) {
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
        assertTrustedOrigin(request, config)
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
        if (isMutating(request.method)) assertTrustedOrigin(request, config)
        await handleAdminRoute(context, url)
        return
    }

    const principal = authenticateApiKey(request, config, controlPlane, apiLimiter)
    if (url.pathname === '/v1/meta' && request.method === 'GET') {
        writeJson(response, 200, { instanceId: sessions.instanceId })
        return
    }
    if (url.pathname === '/v1/agents' && request.method === 'GET') {
        const ids = principal.scope.allAgents
            ? undefined
            : new Set(principal.scope.agentIds)
        writeJson(response, 200, {
            agents: await sessions.listAgents(ids, url.searchParams.get('refresh') === '1')
        })
        return
    }

    const dataArtifactMatch = url.pathname.match(
        /^\/v1\/runs\/([^/]+)\/artifacts\/([^/]+)$/
    )
    if (dataArtifactMatch && request.method === 'GET') {
        const runId = decodeURIComponent(dataArtifactMatch[1])
        const artifactId = decodeURIComponent(dataArtifactMatch[2])
        const run = await getRunForDataPlane(sessions, runId, principal.id)
        assertAgentScope(principal, run.agentId)
        await writeRunArtifact(response, sessions, run, artifactId)
        return
    }
    if (url.pathname === '/v1/sessions' && request.method === 'POST') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['agentId', 'workspace'])
        const agentId = requiredString(body.agentId, 'agentId')
        assertAgentScope(principal, agentId)
        // Reserve before the asynchronous startup path.  The reservation is
        // retained until the session is explicitly closed so a key cannot
        // fill the process with terminal-but-held sessions.
        const releaseSession = context.quota.reserveSession(principal.id)
        try {
            const created = await sessions.create(
                agentId,
                optionalString(body.workspace),
                principal.id
            )
            context.sessionReservations.set(created.id, releaseSession)
            writeJson(response, 201, created)
        } catch (error) {
            releaseSession()
            throw error
        }
        return
    }

    const attachmentMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attachments$/)
    if (attachmentMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(attachmentMatch[1])
        const session = sessions.get(sessionId)
        if (!sessions.owns(sessionId, principal.id)) {
            throw new RequestError(404, 'Session not found')
        }
        assertAgentScope(principal, session.agentId)
        const declared = Number(request.headers['content-length'])
        // When a length is supplied, reject before consuming the body. This
        // keeps a rejected upload from needlessly buffering a request and
        // makes quota failures deterministic under concurrent uploads.
        const preflightUpload = Number.isFinite(declared) && declared > 0
            ? context.quota.reserveUpload(principal.id, declared)
            : undefined
        let releaseUpload: (() => void) | undefined
        try {
            const bytes = await readBytesBody(
                request,
                config.maxAttachmentBytes || 32 * 1024 * 1024
            )
            preflightUpload?.()
            releaseUpload = context.quota.reserveUpload(principal.id, bytes.length)
            const attachment = sessions.addInputAttachment(
                sessionId,
                decodeHeader(request.headers['x-nexus-file-name']) || 'attachment',
                normalizedMediaType(request.headers['content-type']),
                bytes
            )
            const previous = context.uploadReservations.get(sessionId)
            if (previous) {
                // Compose releases so closing the session returns the entire
                // retained upload budget exactly once.
                context.uploadReservations.set(sessionId, composeReleases(previous, releaseUpload))
            } else {
                context.uploadReservations.set(sessionId, releaseUpload)
            }
            writeJson(response, 201, attachment)
        } catch (error) {
            preflightUpload?.()
            releaseUpload?.()
            throw error
        }
        return
    }

    const resolveMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/requests\/([^/]+)\/resolve$/
    )
    if (resolveMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(resolveMatch[1])
        const requestId = decodeURIComponent(resolveMatch[2])
        const session = sessions.get(sessionId)
        if (!sessions.owns(sessionId, principal.id)) {
            throw new RequestError(404, 'Session not found')
        }
        assertAgentScope(principal, session.agentId)
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['message', 'optionId', 'action', 'attachments'])
        const resolution: AgentdPendingResponse = {
            requestId,
            message: optionalString(body.message),
            optionId: optionalRawString(body.optionId, 'optionId'),
            action: optionalPendingAction(body.action)
        }
        if (
            !resolution.message &&
            !resolution.optionId &&
            !resolution.action
        ) {
            throw new RequestError(400, 'A pending response is required')
        }
        const releaseRun = reserveRunIfNeeded(context, principal.id, sessionId, session.state)
        try {
            const updated = await sessions.resolvePending(
                sessionId,
                resolution,
                optionalAttachmentIds(body.attachments)
            )
            if (isTerminalState(updated.state)) releaseRunReservation(context, sessionId)
            writeJson(response, 202, updated)
        } catch (error) {
            releaseRun?.()
            throw error
        }
        return
    }

    const publishMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/artifacts\/publish$/
    )
    if (publishMatch && request.method === 'POST') {
        const sessionId = decodeURIComponent(publishMatch[1])
        const session = sessions.get(sessionId)
        if (!sessions.owns(sessionId, principal.id)) {
            throw new RequestError(404, 'Session not found')
        }
        assertAgentScope(principal, session.agentId)
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['path', 'paths'])
        const paths = normalizePublishPaths(body)
        const result = await sessions.publishFile(sessionId, paths)
        writeJson(response, 201, {
            ...result.session,
            publishedArtifacts: result.artifacts
        })
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
    reconcileRunReservation(context, principal.id, sessionId, session.state)

    if (!action && request.method === 'GET') {
        writeJson(response, 200, session)
        return
    }
    if (!action && request.method === 'DELETE') {
        const closed = await sessions.close(sessionId)
        releaseSessionReservations(context, sessionId)
        releaseRunReservation(context, sessionId)
        writeJson(response, 200, closed)
        return
    }
    if (action === 'message' && request.method === 'POST') {
        assertJsonContentType(request)
        const body = await readJsonBody(request, config.maxRequestBytes)
        assertOnlyKeys(body, ['message', 'attachments'])
        const releaseRun = reserveRunIfNeeded(context, principal.id, sessionId, session.state)
        try {
            const updated = await sessions.message(
                sessionId,
                requiredMessage(body.message),
                optionalAttachmentIds(body.attachments)
            )
            if (isTerminalState(updated.state)) releaseRunReservation(context, sessionId)
            writeJson(response, 202, updated)
        } catch (error) {
            releaseRun?.()
            throw error
        }
        return
    }
    if (action === 'cancel' && request.method === 'POST') {
        await assertEmptyJsonBody(request, config.maxRequestBytes)
        const canceled = await sessions.cancel(sessionId)
        releaseRunReservation(context, sessionId)
        writeJson(response, 200, canceled)
        return
    }
    if (action === 'events' && request.method === 'GET') {
        const releaseSse = context.acquireSse(principal.id)
        if (!releaseSse) {
            throw new RequestError(429, 'SSE connection capacity has been reached')
        }
        streamSessionEvents(
            request,
            response,
            sessions,
            sessionId,
            url.searchParams.get('after') ?? (stringHeader(request.headers['last-event-id']) || undefined),
            releaseSse,
            (close) => controlPlane?.watchApiKey(
                principal.id, stringHeader(request.headers.authorization).slice(7), session.agentId, close
            ) || (() => {})
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
        request,
        response,
        metrics,
        diagnostics
    } = context
    if (!controlPlane) throw new RequestError(404, 'Control plane is unavailable')

    if (url.pathname === '/v1/admin/overview' && request.method === 'GET') {
        const agents = await sessions.listAgents(undefined, url.searchParams.get('refresh') === '1')
        writeJson(response, 200, { agents, sessions: sessions.count() })
        return
    }
    if (url.pathname === '/v1/admin/metrics' && request.method === 'GET') {
        const all = sessions.listRuns({ limit: 1 })
        const actionStates = new Set(['failed', 'input_required', 'permission_required'])
        const recent = new Map<string, any>()
        for (const state of actionStates) {
            for (const run of sessions.listRuns({ state: state as import('./types.js').AgentdSessionState, limit: 5 }).runs) {
                recent.set(run.id, run)
            }
        }
        const recentRuns = Array.from(recent.values())
            .sort((left, right) => right.updatedAt - left.updatedAt)
            .slice(0, 5)
        const baseStats = all.stats || { active: 0, completed: 0, failed: 0 }
        const runStats = {
            active: Number(baseStats.active) || 0,
            completed: Number(baseStats.completed) || 0,
            failed: Number(baseStats.failed) || 0,
            total: Number(all.total) || 0
        }
        writeJson(
            response,
            200,
            await metrics.snapshot({
                sessions: sessions.count(),
                currentSse: currentSseCount(context),
                runs: runStats,
                recentRuns,
                storagePath: config.workspaceRoots[0],
                storageMetrics: (sessions as unknown as {
                    getStorageMetrics?: () => ReturnType<SessionManager['getStorageMetrics']>
                }).getStorageMetrics?.(),
                quotas: context.quota
            })
        )
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
                offset: boundedOffset(url.searchParams.get('offset')),
                limit: boundedLimit(url.searchParams.get('limit'))
            })
        )
        return
    }
    const runActionMatch = url.pathname.match(
        /^\/v1\/admin\/runs\/([^/]+)\/(cancel|retry|respond)$/
    )
    if (runActionMatch) {
        await handleAdminRunAction(context, decodeURIComponent(runActionMatch[1]), runActionMatch[2] as 'cancel' | 'retry' | 'respond')
        return
    }
    const adminArtifactMatch = url.pathname.match(
        /^\/v1\/admin\/runs\/([^/]+)\/artifacts\/([^/]+)$/
    )
    if (adminArtifactMatch && request.method === 'GET') {
        const run = sessions.getRun(decodeURIComponent(adminArtifactMatch[1]))
        await writeRunArtifact(
            response,
            sessions,
            run,
            decodeURIComponent(adminArtifactMatch[2])
        )
        return
    }
    const runMatch = url.pathname.match(/^\/v1\/admin\/runs\/([^/]+)$/)
    if (runMatch && request.method === 'GET') {
        const runId = decodeURIComponent(runMatch[1])
        const detail = sessions.getRun(runId)
        writeJson(response, 200, {
            ...detail,
            controls: buildRunControls(sessions, detail)
        })
        return
    }
    const diagnosticMatch = url.pathname.match(/^\/v1\/admin\/agents\/([^/]+)\/diagnostics$/)
    if (diagnosticMatch && request.method === 'POST') {
        await assertEmptyJsonBody(request, config.maxRequestBytes)
        const agentId = decodeURIComponent(diagnosticMatch[1])
        const configured = controlPlane.snapshot().agents.find((agent) => agent.id === agentId)
        const workspace = configured?.workspace
        const result = await diagnostics.run(
            sessions,
            agentId,
            workspace,
            configured as any
        )
        writeJson(response, result.status === 'busy' ? 429 : 200, result)
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
            const rateKey = remoteKey(request)
            context.revealLimiter.assertAllowed(rateKey)
            context.revealLimiter.failure(rateKey)
            const result = controlPlane.revealApiKey(id)
            console.info(JSON.stringify({ level: 'info', event: 'api_key_revealed', keyId: id, requestId: response.getHeader('X-Request-Id'), remoteAddress: rateKey }))
            writeJson(response, 200, result)
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

async function handleAdminRunAction(
    context: RequestContext,
    runId: string,
    action: 'cancel' | 'retry' | 'respond'
) {
    const { config, sessions, request, response } = context
    const requestId = String(response.getHeader('X-Request-Id') || '')
    let detail: ReturnType<SessionManager['getRun']> | undefined
    let sessionId = ''
    let agentId = ''
    let ownerKeyId: string | undefined
    try {
        if (request.method !== 'POST') throw new RequestError(405, 'Method not allowed')
        detail = sessions.getRun(runId)
        sessionId = detail.sessionId
        agentId = detail.agentId
        ownerKeyId = runOwnerKeyId(sessions, runId)
        const controls = buildRunControls(sessions, detail)
        if (action === 'cancel' && !controls.canCancel) {
            throw new RequestError(409, controls.unavailableReason || 'Run cannot be canceled')
        }
        if (action === 'retry' && !controls.canRetry) {
            throw new RequestError(409, controls.unavailableReason || 'Run cannot be retried')
        }
        if (action === 'cancel' || action === 'retry') {
            await assertEmptyJsonBody(request, config.maxRequestBytes)
        }

        let input: AgentdPendingResponse | undefined
        if (action === 'respond') input = await readAdminRunResponse(request, config.maxRequestBytes)
        // AdminRunManager calls this factory only after its synchronous retry
        // deduplication gate accepts a genuinely new retry. This keeps a
        // completed duplicate from consuming either session or run quota.
        const reserveRetry = action === 'retry'
            ? (keyId: string) => reserveAdminRetry(context, keyId)
            : undefined
        const result = await invokeRunAction(
            sessions,
            action,
            runId,
            sessionId,
            input,
            reserveRetry
        )
        const resultRunId = action === 'retry'
            ? actionResultString(result, 'runId') || actionResultRecord(result, 'run')?.id || runId
            : runId
        const resultSessionId = action === 'retry'
            ? actionResultString(result, 'sessionId') || actionResultRecord(result, 'session')?.id || ''
            : sessionId
        if (!resultSessionId && action === 'retry') {
            throw new RequestError(502, 'Retry did not return a session')
        }
        const state = actionResultString(result, 'state') ||
            actionResultRecord(result, 'session')?.state ||
            actionResultRecord(result, 'run')?.state
        if (action === 'cancel' || state === 'canceled') releaseRunReservation(context, sessionId)
        if (action === 'retry' && state && isTerminalState(state) && resultSessionId) {
            releaseRunReservation(context, resultSessionId)
        }
        auditAdminRunAction({
            action,
            runId,
            sessionId,
            agentId,
            keyId: ownerKeyId,
            requestId,
            result: 'accepted'
        })
        if (action === 'retry') {
            writeJson(response, 202, { runId: resultRunId, sessionId: resultSessionId })
        } else {
            writeJson(response, 202, {
                runId,
                sessionId,
                ...(state ? { state } : {}),
                result: 'accepted'
            })
        }
    } catch (error) {
        auditAdminRunAction({
            action,
            runId,
            sessionId,
            agentId,
            keyId: ownerKeyId,
            requestId,
            result: 'failed'
        })
        throw error
    }
}

async function readAdminRunResponse(request: IncomingMessage, maxBytes: number) {
    assertJsonContentType(request)
    const body = await readJsonBody(request, maxBytes)
    assertOnlyKeys(body, ['requestId', 'message', 'optionId', 'action'])
    const result: AgentdPendingResponse = {
        requestId: requiredString(body.requestId, 'requestId'),
        message: optionalRawString(body.message, 'message'),
        optionId: optionalRawString(body.optionId, 'optionId'),
        action: optionalPendingAction(body.action)
    }
    if (!result.message?.trim() && !result.optionId && !result.action) {
        throw new RequestError(400, 'A pending response is required')
    }
    return result
}

async function invokeRunAction(
    sessions: SessionManager,
    action: 'cancel' | 'retry' | 'respond',
    runId: string,
    sessionId: string,
    input?: AgentdPendingResponse,
    reserveRetry?: AdminRetryReservationFactory
) {
    const target = sessions as unknown as Record<string, any>
    const candidates = action === 'cancel'
        ? ['cancelRun', 'cancelByRunId']
        : action === 'retry'
          ? ['retryRun', 'retryByRunId']
          : ['respondRun', 'respondByRunId']
    for (const name of candidates) {
        if (typeof target[name] !== 'function') continue
        if (action === 'respond') return target[name].call(sessions, runId, input)
        if (action === 'retry') return target[name].call(sessions, runId, reserveRetry)
        return target[name].call(sessions, runId)
    }

    // Cancellation and pending responses can be safely delegated through the
    // existing SessionManager methods. Retry intentionally has no fallback:
    // reconstructing a prompt here could duplicate a run or lose attachments.
    if (action === 'cancel' && typeof target.cancel === 'function') {
        return target.cancel.call(sessions, sessionId)
    }
    if (action === 'respond' && typeof target.resolvePending === 'function') {
        return target.resolvePending.call(sessions, sessionId, input)
    }
    throw new RequestError(409, `Run ${action} is unavailable`)
}

function buildRunControls(sessions: SessionManager, detail: any) {
    const target = sessions as unknown as Record<string, any>
    if (typeof target.getRunControls === 'function') {
        try {
            return structuredClone(target.getRunControls(detail.id))
        } catch {
            // Fall through to the compatibility calculation for embedders
            // that expose getRunControls only for newer run records.
        }
    }
    let session: any
    try {
        session = sessions.get(detail.sessionId)
    } catch {
        session = undefined
    }
    const active = isActiveState(detail.state)
    const canCancel = active && (
        typeof target.cancelRun === 'function' ||
        typeof target.cancelByRunId === 'function' ||
        typeof target.cancel === 'function'
    )
    const canRetry = (detail.state === 'failed' || detail.state === 'canceled') && (
        typeof target.retryRun === 'function' || typeof target.retryByRunId === 'function'
    )
    const pendingRequest = session?.pendingRequest || detail.pendingRequest
    const unavailableReason = !session && active
        ? 'Session is no longer available'
        : active && !canCancel
          ? 'Cancellation is unavailable'
          : (detail.state === 'failed' || detail.state === 'canceled') && !canRetry
            ? 'Retry is unavailable'
            : undefined
    return {
        canCancel,
        canRetry,
        ...(pendingRequest ? { pendingRequest: structuredClone(pendingRequest) } : {}),
        ...(unavailableReason ? { unavailableReason } : {})
    }
}

function runOwnerKeyId(sessions: SessionManager, runId: string) {
    const target = sessions as unknown as Record<string, any>
    for (const name of ['getRunOwnerKeyId', 'runOwnerKeyId', 'ownerKeyForRun']) {
        if (typeof target[name] !== 'function') continue
        const value = target[name].call(sessions, runId)
        if (typeof value === 'string' && value) return value
    }
    return undefined
}

function actionResultString(value: unknown, key: string) {
    return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function actionResultRecord(value: unknown, key: string) {
    return isRecord(value) && isRecord(value[key]) ? value[key] as Record<string, any> : undefined
}

function auditAdminRunAction(input: {
    action: string
    runId: string
    sessionId?: string
    agentId?: string
    keyId?: string
    requestId: string
    result: string
}) {
    console.info(JSON.stringify({
        level: 'info',
        event: 'admin_run_action',
        ...input,
        ...(input.sessionId ? {} : { sessionId: undefined }),
        ...(input.agentId ? {} : { agentId: undefined }),
        ...(input.keyId ? {} : { keyId: undefined })
    }))
}

async function getRunForDataPlane(
    sessions: SessionManager,
    runId: string,
    ownerKeyId: string
): Promise<any> {
    const target = sessions as unknown as Record<string, any>
    for (const name of ['getRunForOwner', 'getRunOwnedBy']) {
        if (typeof target[name] !== 'function') continue
        const result = await target[name].call(sessions, runId, ownerKeyId)
        if (!result) throw new RequestError(404, 'Run not found')
        return result
    }
    if (typeof target.ownsRun === 'function') {
        const owned = await target.ownsRun.call(sessions, runId, ownerKeyId)
        if (!owned) throw new RequestError(404, 'Run not found')
    }
    const run = sessions.getRun(runId)
    if (typeof target.ownsRun !== 'function') {
        // Before the worker adds a direct RunStore wrapper, use the original
        // Session ownership check. It deliberately fails closed for persisted
        // runs whose in-memory Session has already been evicted.
        try {
            if (!sessions.owns(run.sessionId, ownerKeyId)) throw new Error()
        } catch {
            throw new RequestError(404, 'Run not found')
        }
    }
    return run
}

async function writeRunArtifact(
    response: ServerResponse,
    sessions: SessionManager,
    run: any,
    artifactId: string
) {
    const artifact = Array.isArray(run.artifacts)
        ? run.artifacts.find((value: any) => value?.id === artifactId)
        : undefined
    if (!artifact) throw new RequestError(404, 'Artifact not found')
    const payload = await resolveArtifactPayload(sessions, run.id, artifactId)
    if (!payload) throw new RequestError(404, 'Artifact bytes are unavailable')
    const filename = safeDownloadFilename(payload.filename || artifact.filename || artifact.name || artifactId)
    const mediaType = cleanMediaType(payload.mediaType || artifact.mediaType)
    response.writeHead(200, {
        'Content-Type': mediaType,
        'Content-Length': payload.bytes.length,
        'Content-Disposition': contentDisposition(filename),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    })
    response.end(payload.bytes)
}

async function resolveArtifactPayload(
    sessions: SessionManager,
    runId: string,
    artifactId: string
): Promise<ArtifactReadResult | undefined> {
    return sessions.readRunArtifact(runId, artifactId) as Promise<ArtifactReadResult | undefined>
}

function safeDownloadFilename(value: unknown) {
    const text = String(value || 'artifact')
        .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180)
    return text || 'artifact'
}

function contentDisposition(filename: string) {
    const fallback = filename.replace(/[^A-Za-z0-9._-]/g, '_') || 'artifact'
    return `attachment; filename="${fallback.replace(/"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function cleanMediaType(value: unknown) {
    const text = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''
    return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(text)
        ? text
        : 'application/octet-stream'
}

function currentSseCount(context: RequestContext) {
    return context.currentSse()
}

function reserveRunIfNeeded(
    context: RequestContext,
    keyId: string,
    sessionId: string,
    state: string
) {
    if (isTerminalState(state)) {
        releaseRunReservation(context, sessionId)
        return undefined
    }
    if (context.runReservations.has(sessionId)) return undefined
    const releaseQuota = context.quota.reserveRunningRun(keyId, sessionId)
    let released = false
    const release = () => {
        if (released) return
        released = true
        if (context.runReservations.get(sessionId) === release) context.runReservations.delete(sessionId)
        releaseQuota()
    }
    context.runReservations.set(sessionId, release)
    return release
}

function reconcileRunReservation(
    context: RequestContext,
    keyId: string,
    sessionId: string,
    state: string
) {
    if (isTerminalState(state)) {
        releaseRunReservation(context, sessionId)
        context.quota.finishRun(sessionId, keyId)
    }
}

function releaseRunReservation(context: RequestContext, sessionId: string) {
    const release = context.runReservations.get(sessionId)
    if (release) release()
    else context.quota.finishRun(sessionId)
}

function releaseSessionReservations(context: RequestContext, sessionId: string) {
    const releaseSession = context.sessionReservations.get(sessionId)
    if (releaseSession) {
        context.sessionReservations.delete(sessionId)
        releaseSession()
    }
    const releaseUpload = context.uploadReservations.get(sessionId)
    if (releaseUpload) {
        context.uploadReservations.delete(sessionId)
        releaseUpload()
    }
}

function reserveAdminRetry(
    context: RequestContext,
    keyId: string
): AdminRetryReservation {
    const releaseSessionQuota = context.quota.reserveSession(keyId)
    let releaseRunQuota: (() => void) | undefined
    try {
        releaseRunQuota = context.quota.reserveRunningRun(keyId)
    } catch (error) {
        releaseSessionQuota()
        throw error
    }

    let sessionId: string | undefined
    let sessionReleased = false
    let runReleased = false
    const releaseSession = () => {
        if (sessionReleased) return
        sessionReleased = true
        if (sessionId && context.sessionReservations.get(sessionId) === releaseSession) {
            context.sessionReservations.delete(sessionId)
        }
        releaseSessionQuota()
    }
    const releaseRun = () => {
        if (runReleased) return
        runReleased = true
        if (sessionId && context.runReservations.get(sessionId) === releaseRun) {
            context.runReservations.delete(sessionId)
        }
        releaseRunQuota?.()
    }

    return {
        bind(id: string) {
            if (sessionId) return
            sessionId = id
            context.sessionReservations.set(id, releaseSession)
            context.runReservations.set(id, releaseRun)
        },
        release() {
            releaseSession()
            releaseRun()
        }
    }
}

function composeReleases(left: () => void, right: () => void) {
    let released = false
    return () => {
        if (released) return
        released = true
        left()
        right()
    }
}

function isActiveState(state: string) {
    return state === 'running' || state === 'input_required' || state === 'permission_required'
}

function isTerminalState(state: string) {
    return state === 'completed' || state === 'failed' || state === 'canceled'
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function readAgentUpdate(body: Record<string, unknown>): AgentdAgentUpdate {
    assertOnlyKeys(body, [
        'protocol',
        'driver',
        'name',
        'description',
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
        'timeoutMs',
        'taskTimeoutMs',
        'streamIdleTimeoutMs'
    ])
    return {
        protocol: requiredString(body.protocol, 'protocol') as AgentdProtocol,
        driver: optionalString(body.driver) as AgentdDriverKind | undefined,
        name: optionalString(body.name),
        description: optionalString(body.description),
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
        timeoutMs: optionalNumber(body.timeoutMs, 'timeoutMs'),
        taskTimeoutMs: body.taskTimeoutMs === null ? null : optionalNumber(body.taskTimeoutMs, 'taskTimeoutMs'),
        streamIdleTimeoutMs: body.streamIdleTimeoutMs === null ? null : optionalNumber(body.streamIdleTimeoutMs, 'streamIdleTimeoutMs')
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

function boundedOffset(value: string | null) {
    if (value === null) return 0
    if (!/^\d{1,9}$/.test(value)) throw new RequestError(400, 'offset must be a non-negative integer')
    return Number(value)
}

function safePath(value?: string) {
    try {
        return new URL(value || '/', 'http://localhost').pathname
    } catch {
        return '/invalid-url'
    }
}

function errorStatus(error: unknown) {
    if (error instanceof RunNotFoundError) return 404
    if (error instanceof SessionNotFoundError) return 404
    if (error instanceof SessionRequestError) return error.status
    if (error instanceof ControlPlaneError) return error.status
    if (error instanceof RequestError) return error.status
    if (error instanceof QuotaExceededError || error instanceof DiagnosticConcurrencyError) return 429
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

function writeError(response: ServerResponse, status: number, error: unknown, requestId: string) {
    if (error instanceof QuotaExceededError) {
        writeJson(response, status, {
            error: 'Quota exceeded',
            quota: error.quota,
            limit: error.limit,
            current: error.current,
            retryAfterMs: error.retryAfterMs,
            requestId
        })
        return
    }
    if (error instanceof DiagnosticConcurrencyError) {
        writeJson(response, status, {
            error: 'Diagnostic capacity has been reached',
            quota: 'diagnostics',
            retryAfterMs: error.retryAfterMs,
            requestId
        })
        return
    }
    writeJson(response, status, {
        error: status >= 500 ? 'Internal server error' : errorMessage(error),
        requestId
    })
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
        // Bound untrusted remote-address cardinality and evict expired failures.
        for (const [id, item] of this.entries) {
            if (item.blockedUntil <= now && now - item.windowStartedAt >= this.windowMs) this.entries.delete(id)
        }
        if (!this.entries.has(key) && this.entries.size >= 4096) {
            throw new RequestError(429, 'Too many authentication attempts')
        }
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
