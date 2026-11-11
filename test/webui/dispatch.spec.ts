import { test, expect, agents, config } from './fixtures.js'

test('dispatch selects remote policy and model settings, then shows persistent execution logs', async ({ page }) => {
    let payload: any
    await page.route('**/v1/admin/runs', async route => {
        if (route.request().method() !== 'POST') { await route.fallback(); return }
        payload = route.request().postDataJSON()
        await route.fulfill({ status: 202, json: { id: 'session-new', runId: 'new' } })
    })
    await page.route('**/v1/admin/runs/new', route => route.fulfill({ json: {
        id: 'new', agentId: 'writer', agentName: '写作助手', protocol: 'acp', task: '检查项目', state: 'completed',
        protocolSessionId: 'native', output: '完成', progress: {}, startedAt: Date.now(), artifacts: [],
        events: [{ id: '1', type: 'permission_decision', timestamp: Date.now(), data: { policy: 'auto', outcome: 'allowed' } }]
    } }))
    await page.locator('[data-page="runs"]').click()
    await page.locator('#dispatch-task').click()
    await page.locator('#task-message').fill('检查项目')
    await page.locator('#task-policy').selectOption('auto')
    await page.getByText('模型与会话设置', { exact: true }).click()
    await page.locator('#task-model').fill('provider/model')
    await page.locator('#task-effort').fill('high')
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('[data-detail-log]')).toContainText('permission_decision')
    expect(payload).toMatchObject({ agentId: 'writer', message: '检查项目', options: { model: 'provider/model', effort: 'high', permissionPolicy: 'auto' } })
    await expect(page.locator('[data-run-continue]')).toBeEnabled()
    await page.screenshot({ path: 'test-results/dispatch-light.png', fullPage: true })
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.screenshot({ path: 'test-results/dispatch-dark.png', fullPage: true })
})

test('new native drivers and unattended policy are editable without exposing launch commands', async ({ page }) => {
    await page.route('**/v1/admin/config', route => route.fulfill({ json: { ...config, driverKinds: ['kimi', 'cursor', 'devin', 'zcode', 'minimax', 'antigravity', 'codex-cli'] } }))
    await page.reload()
    await page.locator('[data-page="agents"]').click()
    await page.locator('#add-agent').click()
    await page.locator('#f-id').fill('native')
    await page.locator('#f-name').fill('原生执行器')
    await page.locator('#f-protocol').selectOption('cli')
    await page.locator('#f-driver').selectOption('antigravity')
    await page.locator('#f-permissionPolicy').selectOption('bypass')
    await expect(page.locator('input[name="command"]')).toHaveCount(0)
    let payload: any
    await page.route('**/v1/admin/agents/native', async route => { payload = route.request().postDataJSON(); await route.fulfill({ json: {} }) })
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer')).toBeHidden()
    expect(payload).toMatchObject({ protocol: 'cli', driver: 'antigravity', permissionPolicy: 'bypass' })
})

test('task options hide for A2A and capability discovery populates advertised choices', async ({ page }) => {
    await page.route('**/v1/admin/agents/writer/capabilities', route => route.fulfill({ json: {
        configOptions: [{ id: 'model', category: 'model', options: [{ value: 'provider/live', name: 'Live model' }] }]
    } }))
    await page.locator('[data-page="runs"]').click()
    await page.locator('#dispatch-task').click()
    await page.getByText('模型与会话设置', { exact: true }).click()
    await page.locator('#task-discover').click()
    await expect(page.locator('#task-model-values option')).toHaveAttribute('value', 'provider/live')
    await page.locator('#task-agent').selectOption(agents[1].id)
    await expect(page.locator('[data-task-options]')).toBeHidden()
    await expect(page.locator('[data-task-workspace]')).toBeHidden()
})
