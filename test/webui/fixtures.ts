import { test as base, expect, type Page } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeAgentdWebUi, writeAgentdWebUiModule } from '../../src/webui/index.js'

// Serve the shipped HTML, CSP and modules. Only API responses are fixtures;
// all DOM, IME events, keyboard navigation and focus run in Chromium.
export const test = base.extend<{ bootConsole: void }, { gatewayUrl: string }>({
    gatewayUrl: [async ({}, use) => {
        const server = http.createServer((request, response) => {
            if (request.url === '/ui/') writeAgentdWebUi(response)
            else writeAgentdWebUiModule(response, request.url || '')
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        try { await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
        finally {
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }, { scope: 'worker' }],
    bootConsole: [async ({ page, gatewayUrl }, use) => { await bootstrapPage(page, gatewayUrl); await use() }, { auto: true }]
})

export const agents = [
    { id: 'writer', name: '写作助手', protocol: 'acp', driver: 'codex', enabled: true, workspace: '/workspace/project' },
    { id: 'research', name: '研究助手', protocol: 'a2a', enabled: true }
]
export const config = { agents, driverKinds: ['codex'], workspaceRoots: ['/workspace', '/spare'] }
export const runs = [
    { id: 'active', agentId: 'writer', agentName: '写作助手', protocol: 'acp', task: '中文任务', state: 'permission_required', progress: {}, startedAt: Date.now() - 30_000 },
    { id: 'done', agentId: 'research', agentName: '研究助手', protocol: 'a2a', task: '历史任务', state: 'completed', progress: { phase: '已完成' }, startedAt: 1_700_000_000_000, durationMs: 10_000 }
]
export const key = { id: 'key-1', name: '旧客户端', legacy: true, enabled: true, suffix: '1234', scope: { allAgents: true, agentIds: [] } }

async function bootstrapPage(page: Page, gatewayUrl: string) {
    await page.route('**/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname
        const data = path === '/v1/bootstrap/status' ? { adminSetupRequired: false }
            : path === '/v1/admin/auth/status' ? { authenticated: true }
            : path === '/v1/admin/config' ? config
            : path === '/v1/admin/api-keys' ? { apiKeys: [key] }
            : path === '/v1/admin/overview' ? { agents: agents.map((agent) => ({ ...agent, ready: true })), sessions: 1 }
            : path === '/v1/admin/runs' ? { runs, total: 240, stats: { active: 60, completed: 60, failed: 60 } }
            : path.startsWith('/v1/admin/runs/') ? runs.find((run) => run.id === path.split('/').pop())
            : {}
        await route.fulfill({ json: data })
    })
    await page.goto(gatewayUrl + '/ui/')
    await expect(page.locator('#app')).toBeVisible()
}

export { expect }
