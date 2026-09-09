import { test, expect, agents, runs, config } from './fixtures.js'

const detail = { ...runs[0], task: '原始任务', output: '正在准备', artifacts: [], sessionId: 'session-1', controls: { canCancel: true, canRetry: false } }

test('pending input survives polling and submits the current request explicitly', async ({ page }) => {
    let current: any = { ...detail, controls: { ...detail.controls, pendingRequest: { id: 'pending-1', kind: 'input', prompt: '请选择下一步' } } }
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: current }))
    let body: any
    await page.route('**/v1/admin/runs/active/respond', async (route) => {
        body = route.request().postDataJSON()
        current = { ...detail, state: 'running' }
        await route.fulfill({ json: { run: current } })
    })
    await page.locator('[data-page="runs"]').click()
    await page.locator('[data-run-detail="active"]').click()
    const input = page.locator('#run-response-message')
    await input.fill('补充的信息')
    const original = await input.elementHandle()
    current = { ...current, output: '正在准备\n等待信息' }
    await page.evaluate(async () => (await import('/ui/app/render.js')).refreshOpenRunDrawer())
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
    await expect(input).toHaveValue('补充的信息')
    await expect(input).toBeFocused()
    await page.locator('[data-run-respond]').click()
    await expect(page.locator('#toast-status')).toContainText('已提交')
    expect(body).toEqual({ requestId: 'pending-1', action: 'accept', message: '补充的信息' })
    await expect(input).toHaveCount(0)
})

test('permission control never chooses a permission automatically', async ({ page }) => {
    const pending = { id: 'permission-1', kind: 'permission', prompt: '是否写入文件？', options: [{ id: 'once', name: '允许单次', kind: 'allow_once' }, { id: 'always', name: '始终允许', kind: 'allow_always' }] }
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: { ...detail, controls: { ...detail.controls, pendingRequest: pending } } }))
    const bodies: any[] = []
    await page.route('**/v1/admin/runs/active/respond', async (route) => { bodies.push(route.request().postDataJSON()); await route.fulfill({ json: {} }) })
    await page.locator('[data-page="runs"]').click()
    await page.locator('[data-run-detail="active"]').click()
    await page.locator('[data-run-respond]').click()
    await expect(page.locator('[data-response-error]')).toContainText('请选择')
    expect(bodies).toHaveLength(0)
    await page.locator('#run-response-option').selectOption('once')
    await page.locator('[data-run-respond]').click()
    await expect(page.locator('#toast-status')).toContainText('已提交')
    expect(bodies).toEqual([{ requestId: 'permission-1', action: 'accept', optionId: 'once' }])
})

test('cancel and retry use explicit admin operations and keep the new run identity', async ({ page }) => {
    let current: any = detail
    const operations: string[] = []
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: current }))
    await page.route('**/v1/admin/runs/active/cancel', async (route) => {
        operations.push('cancel')
        current = { ...detail, state: 'canceled', controls: { canCancel: false, canRetry: true } }
        await route.fulfill({ json: { run: current } })
    })
    await page.route('**/v1/admin/runs/active/retry', async (route) => { operations.push('retry'); await route.fulfill({ json: { runId: 'retry-1', sessionId: 'new-session' } }) })
    await page.route('**/v1/admin/runs/retry-1', (route) => route.fulfill({ json: { ...detail, id: 'retry-1', retryOfRunId: 'active', sessionId: 'new-session' } }))
    await page.locator('[data-page="runs"]').click()
    await page.locator('[data-run-detail="active"]').click()
    await page.locator('[data-run-cancel]').click()
    await expect(page.locator('#drawer-title')).toHaveText('取消任务')
    expect(operations).toEqual([])
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('[data-detail-field="state"]')).toHaveText('已取消')
    await page.locator('[data-run-retry]').click()
    await expect(page.locator('#drawer-form')).toContainText('外部操作可能重复执行')
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('[data-detail-field="id"]')).toHaveText('retry-1')
    await expect(page.locator('[data-detail-field="retry"]')).toHaveText('active')
    expect(operations).toEqual(['cancel', 'retry'])
})

test('persisted artifacts have same-origin downloads and metadata-only links stay inert', async ({ page }) => {
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: { ...detail, artifacts: [
        { id: 'report', name: '报告.txt', mediaType: 'text/plain', size: 123, downloadable: true, storageStatus: 'available' },
        { id: 'external', name: '外部地址', url: 'https://untrusted.invalid/private', downloadable: false, storageStatus: 'metadata_only' },
        { id: 'expired', name: '过期文件', downloadable: false, storageStatus: 'expired' }
    ] } }))
    await page.locator('[data-page="runs"]').click()
    await page.locator('[data-run-detail="active"]').click()
    const links = page.locator('[data-detail-artifacts] a')
    await expect(links).toHaveCount(1)
    await expect(links).toHaveAttribute('href', '/v1/admin/runs/active/artifacts/report')
    await expect(page.locator('[data-detail-artifacts]')).toContainText('仅元数据')
    await expect(page.locator('[data-detail-artifacts]')).toContainText('已过期')
})

test('output appends preserve selection and scroll unless following latest is enabled', async ({ page }) => {
    let output = 'selected prefix\n' + 'long output line\n'.repeat(100)
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: { ...detail, output } }))
    await page.locator('[data-page="runs"]').click()
    await page.locator('[data-run-detail="active"]').click()
    await expect(page.locator('[data-detail-output]')).toContainText('selected prefix')
    await page.locator('[data-detail-output]').evaluate((element) => {
        element.scrollTop = 80
        const range = document.createRange(); range.setStart(element.firstChild!, 0); range.setEnd(element.firstChild!, 8)
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
        ;(window as any).outputNode = element
    })
    output += 'new result\n'
    await page.evaluate(async () => (await import('/ui/app/render.js')).refreshOpenRunDrawer())
    expect(await page.evaluate(() => getSelection()!.toString())).toBe('selected')
    expect(await page.locator('[data-detail-output]').evaluate((element) => ({ same: element === (window as any).outputNode, top: element.scrollTop }))).toEqual({ same: true, top: 80 })
    await page.locator('[data-follow-output]').check()
    output += 'latest\n'
    await page.evaluate(async () => (await import('/ui/app/render.js')).refreshOpenRunDrawer())
    expect(await page.locator('[data-detail-output]').evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 2)).toBe(true)
})

test('detail refresh is independent of a blocked list read', async ({ page }) => {
    let output = 'before'
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: { ...detail, output } }))
    await page.locator('[data-page="runs"]').click()
    await page.locator('[data-run-detail="active"]').click()
    await expect(page.locator('[data-detail-output]')).toHaveText('before')
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/v1/admin/runs?*', async (route) => { await pending; await route.fulfill({ json: { runs, total: 2, stats: { active: 1, completed: 1, failed: 0 } } }) })
    output = 'after'
    await page.evaluate(() => { void import('/ui/app/data.js').then((data) => data.refreshRuns(false)) })
    await expect(page.locator('[data-detail-output]')).toHaveText('after')
    release()
})

test('navigation restores run identifiers and filters without retaining search text', async ({ page }) => {
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: detail }))
    await page.locator('[data-page="runs"]').click()
    await page.locator('#run-agent-filter').selectOption('research')
    await page.locator('#run-status-filter').selectOption('completed')
    await page.locator('#run-search').fill('private-search-text')
    expect(page.url()).toContain('agent=research')
    expect(page.url()).toContain('state=completed')
    expect(page.url()).not.toContain('private-search-text')
    await page.reload()
    await expect(page.locator('#run-agent-filter')).toHaveValue('research')
    await expect(page.locator('#run-status-filter')).toHaveValue('completed')
    await expect(page.locator('#run-search')).toHaveValue('')
    await page.evaluate(async () => (await import('/ui/app/render.js')).openRunDrawer('active'))
    await expect(page.locator('[data-detail-output]')).toHaveText(detail.output)
    expect(page.url()).toContain('run=active')
    await page.reload()
    await expect(page.locator('[data-detail-output]')).toHaveText(detail.output)
})

test('history polling signals new tasks without shifting the current page', async ({ page }) => {
    await page.locator('[data-page="runs"]').click()
    await page.locator('#runs-next').click()
    await expect(page.locator('.run-pagination')).toContainText('第 2 页')
    const before = await page.locator('.run-table tbody').innerText()
    await page.route('**/v1/admin/runs?*', (route) => route.fulfill({ json: { runs: [{ ...runs[1], id: 'new-position', task: 'shifted-row' }], total: 241, stats: { active: 61, completed: 60, failed: 60 } } }))
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    await expect(page.locator('#runs-show-new')).toBeVisible()
    expect(await page.locator('.run-table tbody').innerText()).toBe(before)
    await page.locator('#runs-show-new').click()
    await expect(page.locator('.run-pagination')).toContainText('第 1 页')
})

test('overview uses global metrics and exposes recent failures', async ({ page }) => {
    await page.route('**/v1/admin/metrics', (route) => route.fulfill({ json: { rssBytes: 64 * 1024 * 1024, sessions: 7, activeSse: 2, quotaRejections: 3, storageMetrics: { historyBytes: 1048576, retainedRuns: 12, pendingWrites: 0, writeFailures: 0 }, runs: { active: 9, completed: 2, failed: 1, total: 12 }, recentRuns: [{ ...runs[1], state: 'failed', taskPreview: '需要检查的失败任务' }] } }))
    await page.locator('[data-page="overview"]').click()
    await expect(page.locator('#page-results')).toContainText('需要检查的失败任务')
    await expect(page.locator('.stat').filter({ hasText: '活动任务' }).locator('strong')).toHaveText('9')
    await expect(page.locator('.stat').filter({ hasText: '现有会话' }).locator('strong')).toHaveText('7')
    await expect(page.locator('.stat').filter({ hasText: '历史文件' }).locator('strong')).toHaveText('1.0 MiB')
    await expect(page.locator('.stat').filter({ hasText: '待写入' }).locator('strong')).toHaveText('0')
})

test('stdio onboarding and explicit connection diagnostics are available', async ({ page }) => {
    await page.route('**/v1/admin/config', (route) => route.fulfill({ json: { ...config, agents: [{ ...agents[0], driver: 'stdio' }] } }))
    const calls: string[] = []
    await page.route('**/v1/admin/agents/writer/diagnostics', async (route) => { calls.push(route.request().method()); await route.fulfill({ json: { ok: true, stages: [{ name: 'ACP 握手', status: 'passed', message: '连接成功' }] } }) })
    await page.reload()
    await page.locator('[data-page="agents"]').click()
    await page.locator('#stdio-guide').click()
    await expect(page.locator('#drawer-form')).toContainText('"driver": "stdio"')
    await page.locator('#drawer-close').click()
    await page.locator('[data-agent-diagnostics="writer"]').click()
    await expect(page.locator('#drawer-form')).toContainText('连接诊断通过')
    expect(calls).toEqual(['POST'])
})

test('bounded list rendering records a repeatable browser baseline', async ({ page }) => {
    await page.locator('[data-page="runs"]').click()
    const results = await page.evaluate(async () => {
        const { state } = await import('/ui/app/state.js')
        const { renderRuns } = await import('/ui/app/render.js')
        const measurements = []
        for (const count of [50, 200]) {
            state.runs = Array.from({ length: count }, (_, i) => ({ id: 'bench-' + i, agentId: 'writer', agentName: 'Benchmark', protocol: 'acp', state: 'completed', taskPreview: 'x'.repeat(240), error: 'e'.repeat(600), progress: {}, startedAt: Date.now(), durationMs: 1000 }))
            state.runTotal = count; state.runPageSize = count; state.runOffset = 0
            const start = performance.now(); renderRuns()
            measurements.push({ count, renderMs: performance.now() - start, responseBytes: new TextEncoder().encode(JSON.stringify(state.runs)).byteLength })
        }
        return measurements
    })
    console.log('WebUI list baseline: ' + JSON.stringify(results))
    for (const result of results) { expect(result.renderMs).toBeLessThan(2000); expect(result.responseBytes / result.count).toBeLessThan(1400) }
})
