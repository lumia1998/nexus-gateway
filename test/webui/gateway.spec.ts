import { test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { ensureAgentdConfig, loadAgentdConfig } from '../../src/config.js'
import { AgentdControlPlane } from '../../src/control-plane.js'
import { createAgentdServer } from '../../src/server.js'
import { closeServer } from '../../src/index.js'
import { SessionManager } from '../../src/session.js'
import { WorkspacePolicy } from '../../src/workspace.js'
import { RunStore } from '../../src/run-store.js'

test('real gateway: first setup, login, settings validation, and historical search', async ({ page }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nexus-browser-gateway-'))
    const configPath = path.join(directory, 'config.json')
    await ensureAgentdConfig(configPath, { workspace: directory })
    const config = await loadAgentdConfig(configPath)
    const store = new RunStore(path.join(directory, 'runs.json'))
    await store.init()
    const manager = new SessionManager(config, await WorkspacePolicy.create([directory]), new Map(), store)
    const control = new AgentdControlPlane(configPath, config, manager)
    const server = createAgentdServer(config, manager, control)
    await new Promise<void>((resolve) => server.listen(0, config.listen.host, resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
        expect((server.address() as AddressInfo).address).toBe('0.0.0.0')
        await page.goto(base + '/ui/')
        await page.locator('#setup-token').fill(control.setupToken!)
        await page.locator('#setup-password').fill('integration-password')
        await page.locator('#setup-confirm').fill('integration-password')
        await page.getByRole('button', { name: '完成初始化' }).click()
        await expect(page.locator('#login-screen')).toBeVisible()
        await page.locator('#login-password').fill('integration-password')
        await page.getByRole('button', { name: '登录', exact: true }).click()
        await expect(page.locator('#app')).toBeVisible()
        await page.locator('[data-page="settings"]').click()
        await page.locator('#session-ttl-hours').fill('48')
        await page.locator('#settings-current-password').fill('integration-password')
        await page.locator('#settings-new-password').fill('replacement-password')
        await page.locator('#settings-confirm-password').fill('mismatched-password')
        await page.getByRole('button', { name: '保存密码', exact: true }).click()
        await expect(page.locator('#password-form [data-password-error]')).toContainText('不一致')
        expect((await loadAgentdConfig(configPath)).sessionTtlMs).toBe(24 * 3_600_000)
        for (const id of ['settings-current-password', 'settings-new-password', 'settings-confirm-password']) await page.locator('#' + id).fill('')
        await page.getByRole('button', { name: '保存更改', exact: true }).click()
        await expect(page.locator('#toast-status')).toContainText('运行参数已保存')
        expect((await loadAgentdConfig(configPath)).sessionTtlMs).toBe(48 * 3_600_000)
        const old = store.create({ sessionId: 'old-session', agentId: 'demo', agentName: 'Demo', protocol: 'acp', task: 'older-needle', ownerKeyId: 'synthetic' })
        store.update(old.id, { state: 'completed', output: 'old result' })
        // Ensure this task is truly outside the newest page, not just absent from a mock response.
        await new Promise((resolve) => setTimeout(resolve, 5))
        for (let i = 0; i < 205; i++) {
            const run = store.create({ sessionId: 'synthetic-' + i, agentId: 'demo', agentName: 'Demo', protocol: 'acp', task: 'task-' + i, ownerKeyId: 'synthetic' })
            store.update(run.id, { state: 'completed' })
        }
        expect(store.list({ limit: 200 }).runs.some((run) => run.id === old.id)).toBe(false)
        await page.locator('[data-page="runs"]').click()
        await expect(page.locator('#run-search')).toBeVisible()
        await page.locator('#run-search').fill('older-needle')
        await expect(page.locator('.run-pagination')).toContainText('共 1 条')
        await page.locator('[data-run-detail="' + old.id + '"]').click()
        await expect(page.locator('#drawer-form')).toContainText('old result')
        store.update(old.id, { output: 'updated result' })
        await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
        await expect(page.locator('#drawer-form')).toContainText('updated result')
    } finally {
        await closeServer(server); await manager.shutdown(); await store.flush()
        await rm(directory, { recursive: true, force: true })
    }
})
