import { test, expect, agents, config, runs, key } from './fixtures.js'

for (const target of ['runs', 'agents']) {
    test(`${target}: polling preserves composition, selection, filters and topbar focus`, async ({ page }) => {
        await page.locator(`[data-page="${target}"]`).click()
        const input = page.locator(target === 'runs' ? '#run-search' : '#agent-search')
        await input.focus()
        await input.evaluate((element: HTMLInputElement) => {
            ;(window as any).originalSearch = element
            element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
            element.value = 'zhong'
            element.setSelectionRange(1, 4)
            element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
        })
        const before = await page.locator('#page-results').innerHTML()
        if (target === 'runs') await page.route('**/v1/admin/runs?*', (route) => route.fulfill({ json: {
            runs: runs.map((run) => ({ ...run, progress: { phase: '轮询更新' } })), total: 240, stats: { active: 60, completed: 60, failed: 60 }
        } }))
        await page.evaluate(async (target) => {
            const data = await import('/ui/app/data.js')
            if (target === 'runs') await data.refreshRuns(false)
            else await data.refreshReadiness(false)
        }, target)
        expect(await input.evaluate((element: HTMLInputElement) => ({ same: element === (window as any).originalSearch, value: element.value, start: element.selectionStart, end: element.selectionEnd })))
            .toEqual({ same: true, value: 'zhong', start: 1, end: 4 })
        await expect(input).toBeFocused()
        if (target === 'agents') expect(await page.locator('#page-results').innerHTML()).toBe(before)
        else await expect(page.locator('#page-results')).toContainText('轮询更新')
        await input.evaluate((element: HTMLInputElement) => {
            element.value = '中文'
            element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }))
        })
        await expect(page.locator('#page-results')).not.toContainText('历史任务')
        if (target === 'agents') await expect(page.locator('#page-results')).toContainText('没有符合条件的智能体')
        await input.fill('')
        const filter = page.locator(target === 'runs' ? '#run-status-filter' : '#protocol-filter')
        const handle = await filter.elementHandle()
        await filter.selectOption(target === 'runs' ? 'completed' : 'a2a')
        expect(await handle!.evaluate((element) => element.isConnected)).toBe(true)
        const refresh = page.locator(`#refresh-${target}`)
        await refresh.focus()
        await page.evaluate(async (target) => {
            const data = await import('/ui/app/data.js')
            if (target === 'runs') await data.refreshRuns(false)
            else await data.refreshReadiness(false)
        }, target)
        await expect(refresh).toBeFocused()
    })
}

test('page slots clear on navigation and empty data; announcements avoid unchanged polling', async ({ page }) => {
    await page.locator('[data-page="runs"]').click()
    await expect(page.locator('#page-stats')).toContainText('240')
    await expect(page.locator('#page-stats')).toContainText('记录总数')
    await expect(page.locator('.run-progress')).toHaveCount(0)
    await page.evaluate(() => {
        ;(window as any).announcements = 0
        new MutationObserver(() => (window as any).announcements++).observe(document.getElementById('page-status')!, { childList: true, subtree: true })
    })
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    expect(await page.evaluate(() => (window as any).announcements)).toBe(0)
    for (const target of ['workspaces', 'keys', 'settings', 'overview']) {
        await page.locator(`[data-page="${target}"]`).click()
        await expect(page.locator('#page-toolbar')).toBeEmpty()
        await expect(page.locator('#page-stats')).toBeEmpty()
        await expect(page.locator(`[data-page="${target}"]`)).toHaveAttribute('aria-current', 'page')
    }
    await page.locator('[data-page="runs"]').click()
    await page.route('**/v1/admin/runs?*', (route) => route.fulfill({ json: { runs: [], total: 0, stats: { active: 0, completed: 0, failed: 0 } } }))
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    await expect(page.locator('#page-toolbar')).toBeEmpty()
    await expect(page.locator('#page-stats')).toBeEmpty()
    await expect(page.locator('#page-results')).toContainText('暂无运行记录')
})

test('settings runtime and password forms validate and save independently', async ({ page }) => {
    const writes: string[] = []
    await page.route('**/v1/admin/config/runtime', async (route) => {
        writes.push('runtime')
        await route.fulfill({ json: { ...config, ...route.request().postDataJSON() } })
    })
    await page.route('**/v1/admin/password', async (route) => {
        writes.push('password')
        await route.fulfill({ status: 403, json: { error: 'Current Console Password is incorrect' } })
    })
    await page.locator('[data-page="settings"]').click()
    await page.locator('#session-ttl-hours').fill('48')
    await page.locator('#settings-current-password').fill('old-password-value')
    await page.locator('#settings-new-password').fill('new-password-value')
    await page.locator('#settings-confirm-password').fill('different-password')
    await page.locator('#password-save').click()
    await expect(page.locator('#password-form [data-password-error]')).toContainText('不一致')
    expect(writes).toEqual([])
    await page.locator('#settings-confirm-password').fill('new-password-value')
    await page.locator('#password-save').click()
    await expect(page.locator('#password-form [data-password-error]')).toContainText('控制台密码不正确')
    expect(writes).toEqual(['password'])
    await page.getByRole('button', { name: '保存更改', exact: true }).click()
    await expect(page.locator('#toast-status')).toContainText('运行参数已保存')
    expect(writes).toEqual(['password', 'runtime'])
    expect(await page.evaluate(async () => (await import('/ui/app/state.js')).state.config.sessionTtlMs)).toBe(48 * 3_600_000)
})

test('slow overview probes do not block the authenticated shell or settings', async ({ page }) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/v1/admin/overview', async (route) => {
        await pending
        await route.fulfill({ json: { agents: agents.map((agent) => ({ ...agent, ready: true })), sessions: 1 } })
    })
    const writes: any[] = []
    await page.route('**/v1/admin/config/runtime', async (route) => {
        writes.push(route.request().postDataJSON())
        await route.fulfill({ json: { ...config, ...route.request().postDataJSON() } })
    })
    await page.reload()
    await expect(page.locator('#app')).toBeVisible()
    await page.locator('[data-page="settings"]').click()
    await expect(page.locator('#settings-form')).toBeVisible()
    await page.locator('#session-ttl-hours').fill('1.5')
    await page.locator('#settings-save').click()
    await expect(page.locator('#toast-status')).toContainText('运行参数已保存')
    expect(writes).toHaveLength(1)
    release()
})

test('password save is independent from invalid runtime fields', async ({ page }) => {
    const writes: string[] = []
    await page.route('**/v1/admin/config/runtime', async (route) => {
        writes.push('runtime')
        await route.fulfill({ json: { ...config, ...route.request().postDataJSON() } })
    })
    await page.route('**/v1/admin/password', async (route) => {
        writes.push('password')
        await route.fulfill({ json: { changed: true } })
    })
    await page.locator('[data-page="settings"]').click()
    await page.locator('#session-ttl-hours').fill('0')
    await page.locator('#settings-current-password').fill('old-password-value')
    await page.locator('#settings-new-password').fill('new-password-value')
    await page.locator('#settings-confirm-password').fill('new-password-value')
    await page.locator('#password-save').click()
    await expect(page.locator('#login-screen')).toBeVisible()
    expect(writes).toEqual(['password'])
})

test('runtime settings preserve sub-unit values without a password write', async ({ page }) => {
    let payload: any
    await page.route('**/v1/admin/config/runtime', async (route) => {
        payload = route.request().postDataJSON()
        await route.fulfill({ json: { ...config, ...payload } })
    })
    await page.locator('[data-page="settings"]').click()
    await page.locator('#session-ttl-hours').fill('1.5')
    await page.locator('#prompt-timeout-minutes').fill('0.1666667')
    await page.locator('#cleanup-interval-seconds').fill('5.123')
    await page.locator('#settings-save').click()
    await expect(page.locator('#toast-status')).toContainText('运行参数已保存')
    expect(payload).toMatchObject({ sessionTtlMs: 5_400_000, promptTimeoutMs: 10_000, cleanupIntervalMs: 5123 })
})

test('successive runtime saves can restore the original value without redundant writes', async ({ page }) => {
    const writes: any[] = []
    await page.route('**/v1/admin/config/runtime', async (route) => {
        writes.push(route.request().postDataJSON())
        await route.fulfill({ json: { ...config, ...writes.at(-1) } })
    })
    await page.locator('[data-page="settings"]').click()
    const ttl = page.locator('#session-ttl-hours')
    await expect(ttl).toHaveValue('24')
    await ttl.fill('1.5')
    await page.locator('#settings-save').click()
    await expect(page.locator('#settings-form')).toHaveAttribute('data-dirty', 'false')
    await page.locator('#settings-save').click()
    await expect(page.locator('#toast-status')).toContainText('没有需要保存的运行参数更改')
    expect(writes).toHaveLength(1)
    await ttl.fill('24')
    await page.locator('#settings-save').click()
    await expect(page.locator('#settings-form')).toHaveAttribute('data-dirty', 'false')
    expect(writes.map((value) => value.sessionTtlMs)).toEqual([5_400_000, 86_400_000])
})

test('editing existing stdio settings preserves precision without exposing local command fields', async ({ page }) => {
    const stdio = { ...agents[0], driver: 'stdio', permissionPolicy: 'ask', permissionTimeoutMs: 12_345 }
    await page.route('**/v1/admin/config', (route) => route.fulfill({ json: { ...config, agents: [stdio], driverKinds: ['stdio', 'codex'] } }))
    let payload: any
    await page.route('**/v1/admin/agents/writer', async (route) => {
        payload = route.request().postDataJSON()
        await route.fulfill({ json: stdio })
    })
    await page.reload()
    await page.locator('[data-page="agents"]').click()
    await page.locator('[data-agent-edit="writer"]').click()
    await expect(page.locator('#f-driver')).toHaveValue('stdio')
    await expect(page.locator('#f-permissionTimeoutMs')).toHaveValue('12.345')
    await expect(page.locator('#drawer [name="command"], #drawer [name="args"], #drawer [name="env"]')).toHaveCount(0)
    await page.locator('#f-name').fill('更新名称')
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer')).toBeHidden()
    expect(payload).toEqual({ protocol: 'acp', name: '更新名称', description: '', enabled: true, driver: 'stdio', workspace: '/workspace/project', permissionPolicy: 'ask', permissionTimeoutMs: 12_345 })
})

test('an initial config failure cannot save fallback runtime defaults', async ({ page }) => {
    let runtimeWrites = 0
    await page.route('**/v1/admin/config', (route) => route.abort('connectionfailed'))
    await page.route('**/v1/admin/config/runtime', async (route) => {
        runtimeWrites++
        await route.fulfill({ json: config })
    })
    await page.reload()
    await expect(page.locator('#app')).toBeVisible()
    await page.locator('[data-page="settings"]').click()
    await expect(page.locator('#settings-save')).toBeDisabled()
    await page.locator('#settings-form').evaluate((form) => (form as HTMLFormElement).requestSubmit())
    expect(runtimeWrites).toBe(0)
})

test('a slow probe completion does not replace a dirty settings form', async ({ page }) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/v1/admin/overview', async (route) => {
        await pending
        await route.fulfill({ json: { agents: agents.map((agent) => ({ ...agent, ready: true })), sessions: 1 } })
    })
    await page.reload()
    await page.locator('[data-page="settings"]').click()
    await page.locator('#session-ttl-hours').fill('1.5')
    release()
    await expect(page.locator('#session-ttl-hours')).toHaveValue('1.5')
})

test('late config enables runtime editing without replacing password input or focus', async ({ page }) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/v1/admin/config', async (route) => {
        await pending
        await route.fulfill({ json: { ...config, sessionTtlMs: 5_400_000 } })
    })
    let payload: any
    await page.route('**/v1/admin/config/runtime', async (route) => {
        payload = route.request().postDataJSON()
        await route.fulfill({ json: { ...config, ...payload } })
    })
    await page.reload()
    await page.locator('[data-page="settings"]').click()
    await expect(page.locator('#session-ttl-hours')).toBeDisabled()
    const password = page.locator('#settings-new-password')
    await password.fill('in-progress-password')
    const original = await password.elementHandle()
    release()
    await expect(page.locator('#session-ttl-hours')).toBeEnabled()
    await expect(page.locator('#session-ttl-hours')).toHaveValue('1.5')
    await expect(password).toBeFocused()
    expect(await original!.evaluate((element) => element.isConnected)).toBe(true)
    await expect(password).toHaveValue('in-progress-password')
    await page.locator('#session-ttl-hours').fill('2')
    await page.locator('#settings-save').click()
    await expect(page.locator('#toast-status')).toContainText('运行参数已保存')
    expect(payload.sessionTtlMs).toBe(7_200_000)
})

test('unread config cannot replace workspace roots and retry restores editing', async ({ page }) => {
    await page.route('**/v1/admin/config', (route) => route.abort('connectionfailed'))
    await page.reload()
    await page.locator('[data-page="workspaces"]').click()
    await expect(page.locator('#page-results')).toContainText('工作区配置读取失败')
    await expect(page.locator('#add-workspace')).toBeDisabled()
    await page.locator('[data-page="agents"]').click()
    await expect(page.locator('#add-agent')).toBeDisabled()
    await page.route('**/v1/admin/config', (route) => route.fulfill({ json: config }))
    await page.locator('[data-resource-retry="config"]').click()
    await expect(page.locator('#add-agent')).toBeEnabled()
    await page.locator('[data-page="workspaces"]').click()
    await expect(page.locator('#add-workspace')).toBeEnabled()
    await expect(page.locator('#page-results')).toContainText('/spare')
})

test('clearing run filters updates the retained controls and sends one unfiltered read', async ({ page }) => {
    await page.locator('[data-page="runs"]').click()
    await expect(page.locator('#clear-run-filters')).toBeHidden()
    await page.locator('#run-search').fill('历史')
    await expect(page.locator('#clear-run-filters')).toBeVisible()
    await page.locator('#run-agent-filter').selectOption('research')
    await page.locator('#run-status-filter').selectOption('completed')
    const requests: string[] = []
    await page.route('**/v1/admin/runs?*', async (route) => {
        requests.push(new URL(route.request().url()).search)
        await route.fulfill({ json: { runs, total: 2, stats: { active: 1, completed: 1, failed: 0 } } })
    })
    await page.locator('#clear-run-filters').click()
    await expect(page.locator('#run-search')).toHaveValue('')
    await expect(page.locator('#run-agent-filter')).toHaveValue('all')
    await expect(page.locator('#run-status-filter')).toHaveValue('all')
    await expect(page.locator('#clear-run-filters')).toBeHidden()
    await expect(page.locator('.run-pagination')).toContainText('共 2 条')
    expect(requests).toEqual(['?limit=50'])
})

test('key rotation shows the new secret even when subsequent list reads are unavailable', async ({ page }) => {
    await page.locator('[data-page="keys"]').click()
    await expect(page.locator('[data-key-menu]')).toBeVisible()
    await page.route('**/v1/admin/api-keys', (route) => route.abort('connectionfailed'))
    let writes = 0
    await page.route('**/v1/admin/api-keys/key-1/regenerate', async (route) => {
        writes++
        await route.fulfill({ json: { key: { ...key, suffix: '9876' }, secret: 'nx_sk_rotated_test_9876' } })
    })
    await page.locator('[data-key-menu]').click()
    await page.locator('[data-key-action="regenerate"]').click()
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer-title')).toHaveText('API 密钥已重新生成')
    await expect(page.locator('.secret-value')).toHaveText('nx_sk_rotated_test_9876')
    await page.locator('#drawer-close').click()
    await expect(page.locator('.key-secret-cell')).toContainText('9876')
    expect(writes).toBe(1)
})

test('a key list read started before rename cannot overwrite the saved name', async ({ page }) => {
    await page.locator('[data-page="keys"]').click()
    await expect(page.locator('[data-key-action="rename"]')).toBeVisible()
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const startedRead = new Promise<void>((resolve) => { started = resolve })
    await page.route('**/v1/admin/api-keys', async (route) => {
        started()
        await pending
        await route.fulfill({ json: { apiKeys: [key] } })
    })
    await page.evaluate(() => {
        ;(window as any).staleKeyRead = import('/ui/app/data.js').then((data) => data.retryResource('apiKeys'))
    })
    await startedRead
    await page.route('**/v1/admin/api-keys/key-1', (route) => route.fulfill({ json: { ...key, name: '新客户端' } }))
    await page.locator('[data-key-action="rename"]').click()
    await page.locator('#f-key-name').fill('新客户端')
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer')).toBeHidden()
    await expect(page.locator('#page-results')).toContainText('新客户端')
    await page.route('**/v1/admin/api-keys', (route) => route.fulfill({ json: { apiKeys: [{ ...key, name: '新客户端' }] } }))
    await page.evaluate(async () => (await import('/ui/app/data.js')).retryResource('apiKeys'))
    release()
    await page.evaluate(() => (window as any).staleKeyRead)
    await expect(page.locator('#page-results')).toContainText('新客户端')
    await expect(page.locator('#page-results')).not.toContainText('旧客户端')
})

test('logout clears password forms and old config before a new login', async ({ page }) => {
    await page.locator('[data-page="settings"]').click()
    await page.locator('#session-ttl-hours').fill('48')
    await page.locator('#settings-new-password').fill('unfinished-password')
    await page.locator('[data-action="logout"]').click()
    await expect(page.locator('#login-screen')).toBeVisible()
    await expect(page.locator('#settings-new-password')).toHaveCount(0)
    expect(await page.evaluate(async () => (await import('/ui/app/state.js')).state.config.agents)).toEqual([])
    await page.route('**/v1/admin/config', (route) => route.fulfill({ json: { ...config, sessionTtlMs: 5_400_000 } }))
    await page.locator('#login-password').fill('valid-console-password')
    await page.locator('#login-form [type="submit"]').click()
    await expect(page.locator('#app')).toBeVisible()
    await expect(page.locator('#session-ttl-hours')).toHaveValue('1.5')
    await expect(page.locator('#settings-new-password')).toHaveValue('')
})

test('a key mutation completed after logout cannot reopen a secret drawer', async ({ page }) => {
    await page.locator('[data-page="keys"]').click()
    await page.locator('#create-key').click()
    await page.locator('#f-name').fill('Pending client')
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/v1/admin/api-keys', async (route) => {
        await pending
        await route.fulfill({ json: { key: { ...key, id: 'late-key' }, secret: 'nx_sk_late_test_secret' } })
    })
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer-footer [type="submit"]')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.locator('[data-action="logout"]').click()
    await expect(page.locator('#login-screen')).toBeVisible()
    release()
    await expect(page.locator('#toast-alert')).toContainText('登录状态已变化')
    await expect(page.locator('#drawer')).toBeHidden()
    expect(await page.evaluate(async () => (await import('/ui/app/state.js')).state.apiKeys)).toEqual([])
})

test('A2A timeout fields keep millisecond precision and preserve inheritance', async ({ page }) => {
    const a2a = {
        id: 'research', name: '研究助手', protocol: 'a2a', enabled: true,
        agentCardUrl: 'http://agent.local/card', timeoutMs: 12_345
    }
    await page.route('**/v1/admin/config', (route) => route.fulfill({ json: { ...config, agents: [a2a] } }))
    let payload: any
    await page.route('**/v1/admin/agents/research', async (route) => {
        payload = route.request().postDataJSON()
        await route.fulfill({ json: a2a })
    })
    await page.reload()
    await page.locator('[data-page="agents"]').click()
    await page.locator('[data-agent-edit="research"]').click()
    await expect(page.locator('#f-taskTimeoutMs')).toHaveValue('')
    await expect(page.locator('#f-streamIdleTimeoutMs')).toHaveValue('')
    await expect(page.locator('#f-timeoutMs')).toHaveValue('12.345')
    await page.locator('#f-timeoutMs').fill('12.346')
    await page.locator('#f-taskTimeoutMs').fill('12.345')
    await page.locator('#f-streamIdleTimeoutMs').fill('2.001')
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer')).toBeHidden()
    expect(payload).toMatchObject({ timeoutMs: 12_346, taskTimeoutMs: 12_345, streamIdleTimeoutMs: 2_001 })
})

test('run search queries all stored records, retains empty filters, and paginates', async ({ page }) => {
    const requests: string[] = []
    const historical = { ...runs[1], id: 'older-than-page', task: 'ancient-needle' }
    await page.route('**/v1/admin/runs?*', async (route) => {
        const url = new URL(route.request().url())
        requests.push(url.search)
        const q = url.searchParams.get('q')
        await route.fulfill({ json: {
            runs: q === 'missing' ? [] : q === 'ancient-needle' || url.searchParams.has('offset') ? [historical] : runs,
            total: q ? q === 'missing' ? 0 : 1 : 240, stats: { active: 1, completed: 239, failed: 0 }
        } })
    })
    await page.locator('[data-page="runs"]').click()
    await page.locator('#runs-next').click()
    await expect(page.locator('#page-results')).toContainText('ancient-needle')
    expect(requests.some((query) => query.includes('offset=50'))).toBe(true)
    await page.locator('#run-search').fill('missing')
    await expect(page.locator('.run-pagination')).toContainText('共 0 条')
    await expect(page.locator('#run-search')).toBeVisible()
    await page.locator('#run-search').fill('ancient-needle')
    await expect(page.locator('.run-pagination')).toContainText('共 1 条')
    await expect(page.locator('#page-results')).toContainText('ancient-needle')
    expect(requests.at(-1)).toContain('q=ancient-needle')
    expect(requests.at(-1)).not.toContain('offset')
})

test('stale search responses cannot replace a newer result', async ({ page }) => {
    await page.locator('[data-page="runs"]').click()
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const start = new Promise<void>((resolve) => { started = resolve })
    await page.route('**/v1/admin/runs?*', async (route) => {
        const old = new URL(route.request().url()).searchParams.get('q') === 'old'
        if (old) { started(); await gate }
        await route.fulfill({ json: { runs: [{ ...runs[1], task: old ? 'old' : 'new' }], total: old ? 111 : 1, stats: {} } })
    })
    await page.evaluate(async () => {
        const { state } = await import('/ui/app/state.js')
        state.runSearch = 'old'
        ;(window as any).oldRefresh = (await import('/ui/app/data.js')).refreshRuns(false)
    })
    await start
    await page.evaluate(async () => {
        (await import('/ui/app/state.js')).state.runSearch = 'new'
        await (await import('/ui/app/data.js')).refreshRuns(false)
    })
    release()
    await page.evaluate(() => (window as any).oldRefresh)
    expect(await page.evaluate(async () => (await import('/ui/app/state.js')).state.runs[0].task)).toBe('new')
    await expect(page.locator('.run-pagination')).toContainText('共 1 条')
})

test('offline polling shows stale data and recovery clears the warning; open details update', async ({ page }) => {
    await page.locator('[data-page="runs"]').click()
    await page.locator('[data-run-detail="active"]').click()
    await expect(page.locator('#drawer-form')).toContainText('等待授权')
    await page.route('**/v1/admin/runs/active', (route) => route.fulfill({ json: { ...runs[0], state: 'completed', output: 'finished-output' } }))
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    await expect(page.locator('#drawer-form')).toContainText('finished-output')
    await expect(page.locator('#drawer-form')).toContainText('已完成')
    await page.locator('#drawer-close').click()
    await page.route('**/v1/admin/runs?*', (route) => route.abort('connectionfailed'))
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    await expect(page.locator('#connection-status')).toBeVisible()
    await expect(page.locator('#connection-status')).toContainText('旧数据')
    await expect(page.locator('.run-card')).toBeVisible()
    await page.route('**/v1/admin/runs?*', (route) => route.fulfill({ json: { runs, total: 2, stats: {} } }))
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    await expect(page.locator('#connection-status')).toBeHidden()
})

test('same read requests coalesce without losing final state', async ({ page }) => {
    let count = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const start = new Promise<void>((resolve) => { started = resolve })
    await page.route('**/v1/admin/runs?*', async (route) => {
        count++; started(); await gate
        await route.fulfill({ json: { runs, total: 2, stats: {} } })
    })
    await page.evaluate(async () => {
        const { refreshRuns } = await import('/ui/app/data.js')
        ;(window as any).parallelRefresh = Promise.all([refreshRuns(false), refreshRuns(false), refreshRuns(false)])
    })
    await start
    release()
    await page.evaluate(() => (window as any).parallelRefresh)
    expect(count).toBe(1)
})

test('agent and history actions fit laptop and phone widths; page survives reload', async ({ page }) => {
    for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 })
        await page.locator('[data-page="agents"]').click()
        const edit = page.locator('[data-agent-edit="writer"]')
        const bounds = await edit.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        expect(await page.locator('.agent-table').evaluate((table) => table.scrollWidth <= table.clientWidth)).toBe(true)
        await edit.click()
        await expect(page.locator('#f-id')).toHaveValue('writer')
        await page.locator('#drawer-close').click()
        await page.locator('[data-page="runs"]').click()
        const detail = await page.locator('[data-run-detail="done"]').boundingBox()
        expect(detail!.x + detail!.width).toBeLessThanOrEqual(width)
        await page.screenshot({ path: `test-results/hardening-runs-${width}.png`, fullPage: true })
    }
    await page.locator('[data-page="keys"]').click()
    await page.reload()
    await expect(page.locator('#page-title')).toHaveText('API 密钥')
})

test('setup requires token input and submits it without storing it', async ({ page }) => {
    await page.route('**/v1/bootstrap/status', (route) => route.fulfill({ json: { adminSetupRequired: true } }))
    let submitted: any
    await page.route('**/v1/bootstrap/initialize', async (route) => {
        submitted = route.request().postDataJSON()
        await route.fulfill({ json: { initialized: true, adminSetupRequired: false } })
    })
    await page.reload()
    await expect(page.locator('#setup-token')).toBeFocused()
    await page.locator('#setup-token').fill('test-process-proof')
    await page.locator('#setup-password').fill('a-test-password')
    await page.locator('#setup-confirm').fill('a-test-password')
    await page.getByRole('button', { name: '完成初始化' }).click()
    await expect(page.locator('#login-screen')).toBeVisible()
    expect(submitted.setupToken).toBe('test-process-proof')
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('test-process-proof')
    expect(page.url()).not.toContain('test-process-proof')
})

test('settings uses a centered, cardless section layout', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.locator('[data-page="settings"]').click()
    await expect(page.locator('#page-title')).toHaveText('设置')
    await expect(page.locator('.settings-section')).toHaveCount(3)
    await expect(page.locator('.settings-layout .panel')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '保存更改', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '修改密码', exact: true })).toHaveCount(0)
    await expect(page.locator('#settings-form')).toBeVisible()
    const desktop = await page.evaluate(() => {
        const main = document.querySelector('.main')!.getBoundingClientRect()
        const layout = document.querySelector('.settings-layout')!.getBoundingClientRect()
        const title = document.querySelector('#page-title')!.getBoundingClientRect()
        const sections = Array.from(document.querySelectorAll('.settings-section')).map((element) => {
            const style = getComputedStyle(element)
            return { background: style.backgroundColor, borderLeft: style.borderLeftStyle, borderRight: style.borderRightStyle, borderBottom: style.borderBottomStyle, radius: style.borderRadius }
        })
        const fields = Array.from(document.querySelectorAll('.settings-fields input, .settings-fields select')).map((element) => element.getBoundingClientRect().width)
        return { centered: Math.abs((layout.left - main.left) - (main.right - layout.right)) < 2, sameBaseline: Math.abs(title.left - layout.left) < 2, sections, fields }
    })
    expect(desktop.centered).toBe(true)
    expect(desktop.sameBaseline).toBe(true)
    expect(desktop.sections.every((section) => section.background === 'rgba(0, 0, 0, 0)' && section.borderLeft === 'none' && section.borderRight === 'none' && section.borderBottom === 'none' && section.radius === '0px')).toBe(true)
    expect(desktop.fields.every((width) => width <= 520.5)).toBe(true)

    await page.setViewportSize({ width: 390, height: 844 })
    const mobile = await page.evaluate(() => {
        const heading = document.querySelector('.settings-account .settings-section-heading')!.getBoundingClientRect()
        const fields = document.querySelector('.settings-account .settings-fields')!.getBoundingClientRect()
        return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth, fieldsTop: fields.top, headingTop: heading.top }
    })
    expect(mobile.pageWidth).toBeLessThanOrEqual(mobile.viewport)
    expect(mobile.fieldsTop).toBeGreaterThan(mobile.headingTop)
})

test('settings keeps one save action and separates logout in the sidebar', async ({ page }) => {
    await page.locator('[data-page="settings"]').click()
    await expect(page.locator('#page-actions')).toContainText('保存更改')
    await expect(page.getByRole('button', { name: '修改密码', exact: true })).toHaveCount(0)
    await expect(page.locator('.settings-section #logout')).toHaveCount(0)
    await expect(page.locator('.nav-group-footer .nav-item')).toHaveCount(2)
    await expect(page.locator('.nav-group-footer [data-page="settings"]')).toHaveText('设置')
    await expect(page.locator('.nav-group-footer [data-action="logout"]')).toHaveText('退出登录')

    await page.locator('.nav-group-footer [data-action="logout"]').click()
    await expect(page.locator('#login-screen')).toBeVisible()
    await expect(page.locator('#app')).toBeHidden()
})

test('permission policy changes refresh the agents list immediately after save', async ({ page }) => {
    const updatedConfig = {
        ...config,
        agents: config.agents.map((agent) => agent.id === 'writer' ? { ...agent, permissionPolicy: 'deny' } : agent)
    }
    await page.route('**/v1/admin/agents/writer', (route) => route.fulfill({ json: updatedConfig.agents[0] }))
    await page.route('**/v1/admin/config', (route) => route.fulfill({ json: updatedConfig }))

    await page.locator('[data-page="agents"]').click()
    await page.locator('[data-agent-edit="writer"]').click()
    await page.locator('#f-permissionPolicy').selectOption('deny')
    await page.locator('#drawer-footer [type="submit"]').click()

    await expect(page.locator('#drawer')).toBeHidden()
    await expect(page.locator('.agent-table tbody tr').first()).toContainText('拒绝')
})

test('workspace rows wrap long paths without widening the page', async ({ page }) => {
    await page.route('**/v1/admin/config', route => route.fulfill({ json: {
        ...config,
        workspaceRoots: ['/workspace', '/workspace/' + 'cross-team-release-quality-assurance-with-a-long-directory-name'.repeat(2)]
    } }))
    await page.reload()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-page="workspaces"]').click()
    const layout = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.workspace-list .list-row')).map((element) => {
            const box = element.getBoundingClientRect()
            const main = element.querySelector('.list-row-main')!
            return { left: box.left, right: box.right, contentWidth: main.clientWidth, contentScrollWidth: main.scrollWidth }
        })
        return { pageWidth: document.documentElement.scrollWidth, viewport: innerWidth, rows }
    })
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport)
    expect(layout.rows.every((row) => row.left >= 0 && row.right <= layout.viewport && row.contentScrollWidth <= row.contentWidth + 1)).toBe(true)
})

test('menu has roving focus and opens a modal with focus containment and restoration', async ({ page }) => {
    await page.locator('[data-page="keys"]').click()
    await expect(page.locator('.key-table')).toContainText('旧客户端')
    await expect(page.locator('.key-table .badge')).toHaveText('旧版')
    const anchor = page.locator('[data-key-menu]')
    await anchor.focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[role="menuitem"]').first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.locator('[role="menuitem"]').last()).toBeFocused()
    await expect(page.locator('[role="menuitem"][tabindex="0"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(anchor).toBeFocused()
    await anchor.press('Enter')
    await page.keyboard.press('Tab')
    await expect(page.locator('#key-action-menu')).toBeHidden()
    await anchor.focus()
    await anchor.press('ArrowUp')
    await page.keyboard.press('Enter')
    const drawer = page.locator('#drawer')
    await expect(drawer).toHaveAccessibleName('删除 API 密钥')
    await expect(page.locator('[data-close-drawer]')).toBeFocused()
    expect(await page.locator('#app').evaluate((element: HTMLElement) => element.inert)).toBe(true)
    expect(await page.locator('#key-action-menu').evaluate((element: HTMLElement) => element.inert)).toBe(true)
    await expect(page.locator('#drawer #notifications')).toHaveCount(1)
    await page.locator('#drawer-footer [type="submit"]').focus()
    await page.keyboard.press('Tab')
    await expect(page.locator('#drawer-close')).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator('#drawer-footer [type="submit"]')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(anchor).toBeFocused()
    expect(await page.locator('#app').evaluate((element: HTMLElement) => element.inert)).toBe(false)
    expect(await page.locator('body').evaluate((element: HTMLElement) => element.style.overflow)).toBe('')
})

test('history keeps table semantics; slow detail requests cannot reopen a closed drawer', async ({ page }) => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    await page.route('**/v1/admin/runs/done', async (route) => { await pending; await route.fulfill({ json: runs[1] }) })
    await page.locator('[data-page="runs"]').click()
    await expect(page.locator('tr[role="button"]')).toHaveCount(0)
    const button = page.locator('td [data-run-detail="done"]')
    await button.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#drawer')).toBeVisible()
    await expect(page.locator('#drawer-form')).toContainText('正在加载')
    await page.keyboard.press('Escape')
    await expect(button).toBeFocused()
    finish()
    await expect(page.locator('#drawer')).toBeHidden()
    await button.click()
    await expect(page.locator('#drawer-title')).toHaveText('运行详情 · 研究助手')
    await page.keyboard.press('Escape')
})

test('refresh and drawer submission show busy state and suppress duplicate submissions', async ({ page }) => {
    await page.locator('[data-page="runs"]').click()
    let finishRefresh!: () => void
    const waitRefresh = new Promise<void>((resolve) => { finishRefresh = resolve })
    await page.route('**/v1/admin/runs?*', async (route) => { await waitRefresh; await route.fulfill({ json: { runs, total: 2, stats: { active: 1, completed: 1, failed: 0 } } }) })
    await page.locator('#refresh-runs').click()
    await expect(page.locator('#refresh-runs')).toBeDisabled()
    await expect(page.locator('#refresh-runs')).toHaveAttribute('aria-busy', 'true')
    finishRefresh()
    await expect(page.locator('#refresh-runs')).toBeEnabled()
    await expect(page.locator('#toast-status')).toBeEmpty()
    await page.locator('[data-page="keys"]').click()
    await page.locator('#create-key').click()
    await page.locator('#f-name').fill('New key')
    let requests = 0
    let finishSubmit!: () => void
    const waitSubmit = new Promise<void>((resolve) => { finishSubmit = resolve })
    await page.route('**/v1/admin/api-keys', async (route) => {
        requests++
        await waitSubmit
        await route.fulfill({ status: 400, json: { error: 'API Key already exists' } })
    })
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer-footer [type="submit"]')).toBeDisabled()
    await page.locator('#drawer-form').evaluate((form: HTMLFormElement) => form.requestSubmit())
    expect(requests).toBe(1)
    finishSubmit()
    await expect(page.locator('#drawer-footer [type="submit"]')).toBeEnabled()
    await expect(page.locator('#drawer-form [data-form-error]')).toHaveText('API 密钥已存在')
})

test('unchanged results retain nodes while an active duration keeps updating', async ({ page }) => {
    await page.locator('[data-page="agents"]').click()
    const edit = await page.locator('[data-agent-edit]').first().elementHandle()
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshReadiness(false))
    expect(await edit!.evaluate((element) => element.isConnected)).toBe(true)
    await page.locator('[data-page="runs"]').click()
    // Finish navigation's real refresh before changing the fixture clock.
    await page.evaluate(async () => (await import('/ui/app/data.js')).refreshRuns(false))
    const duration = await page.locator('.run-meta').innerText()
    await page.evaluate(async () => {
        const { state } = await import('/ui/app/state.js')
        state.runs[0].startedAt -= 60_000
        ;(await import('/ui/app/render.js')).renderRuns()
    })
    expect(await page.locator('.run-meta').innerText()).not.toBe(duration)
})

test('a completed save cannot replace a newer drawer', async ({ page }) => {
    await page.locator('[data-page="keys"]').click()
    await page.locator('#create-key').click()
    await page.locator('#f-name').fill('Saved key')
    let finish!: () => void
    const wait = new Promise<void>((resolve) => { finish = resolve })
    await page.route('**/v1/admin/api-keys', async (route) => {
        await wait
        await route.fulfill({ json: { key: { ...key, id: 'new-key', name: 'Saved key' }, secret: 'test-secret-not-displayed' } })
    })
    await page.locator('#drawer-footer [type="submit"]').click()
    await expect(page.locator('#drawer-footer [type="submit"]')).toBeDisabled()
    await page.keyboard.press('Escape')
    await page.locator('[data-key-action="rename"]').click()
    await page.locator('#f-key-name').fill('Unsaved edit')
    finish()
    await expect(page.locator('#toast-status')).toContainText('API 密钥已创建')
    await expect(page.locator('#drawer-title')).toHaveText('重命名 API 密钥')
    await expect(page.locator('#f-key-name')).toHaveValue('Unsaved edit')
})

test('boot exposes a loading status while authentication is pending', async ({ page }) => {
    let finish!: () => void
    const wait = new Promise<void>((resolve) => { finish = resolve })
    await page.route('**/v1/bootstrap/status', async (route) => { await wait; await route.fulfill({ json: { adminSetupRequired: false } }) })
    await page.reload()
    await expect(page.locator('#boot-screen')).toContainText('正在加载控制台')
    await expect(page.locator('#app')).toBeHidden()
    finish()
    await expect(page.locator('#app')).toBeVisible()
    await expect(page.locator('#boot-screen')).toBeHidden()
})

test('clipboard fallback stays inside the modal focus boundary', async ({ page }) => {
    await page.evaluate(async () => {
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
        document.execCommand = () => {
            const active = document.activeElement as HTMLTextAreaElement
            ;(window as any).copied = { value: active.value, inDrawer: Boolean(active.closest('#drawer')), selection: active.selectionEnd - active.selectionStart }
            return true
        }
        ;(await import('/ui/app/render.js')).showSecret('测试密钥', 'test-copy-value')
    })
    await page.locator('#copy-secret').click()
    expect(await page.evaluate(() => (window as any).copied)).toEqual({ value: 'test-copy-value', inDrawer: true, selection: 15 })
    await expect(page.locator('#copy-secret')).toBeFocused()
    await expect(page.locator('#drawer #toast-status')).toContainText('API 密钥已复制')
    await expect(page.locator('#toast-status')).toHaveAttribute('aria-live', 'polite')
    await expect(page.locator('#toast-alert')).toHaveAttribute('aria-live', 'assertive')
})

test('both themes and narrow navigation remain usable without browser errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    for (const theme of ['light', 'dark']) {
        await page.locator('[data-page="settings"]').click()
        await page.locator('#theme-select').selectOption(theme)
        for (const target of ['runs', 'agents', 'workspaces', 'keys']) {
            await page.locator(`[data-page="${target}"]`).click()
            await expect(page.locator('#page-results')).toBeVisible()
            if (target === 'runs' || target === 'keys') await page.screenshot({ path: test.info().outputPath(`${target}-${theme}.png`), fullPage: true })
        }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('button', { name: '运行记录', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '工作区', exact: true }).click()
    await expect(page.locator('[data-workspace-delete="0"]')).toBeDisabled()
    await page.screenshot({ path: test.info().outputPath('mobile-workspaces.png'), fullPage: true })
    expect(errors).toEqual([])
})

test('long running tasks stay inside a narrow viewport with the status visible', async ({ page }) => {
    await page.route('**/v1/admin/runs?*', (route) => route.fulfill({ json: {
        runs: [
            { ...runs[0], agentName: 'ResearchAssistant'.repeat(8), task: 'LongUnbrokenTaskIdentifier'.repeat(30) },
            { ...runs[1], agentName: '跨团队发布验收助手'.repeat(8), task: 'LongUnbrokenHistoryIdentifier'.repeat(30) }
        ], total: 2, stats: { active: 1, completed: 1, failed: 0 }
    } }))
    await page.setViewportSize({ width: 320, height: 720 })
    await page.locator('[data-page="runs"]').click()
    await expect(page.locator('.run-card')).toHaveCount(1)
    await expect(page.locator('.run-card-agent')).toContainText('ResearchAssistant')
    const bounds = await page.locator('.run-card').evaluate((element) => {
        const card = element.getBoundingClientRect()
        const status = element.querySelector('.status')!.getBoundingClientRect()
        return { page: document.documentElement.scrollWidth, viewport: innerWidth, right: card.right, statusRight: status.right }
    })
    expect(bounds.page).toBeLessThanOrEqual(bounds.viewport)
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport)
    expect(bounds.statusRight).toBeLessThanOrEqual(bounds.right)
    const history = await page.locator('.run-table .agent-name strong').boundingBox()
    expect(history!.width).toBeGreaterThanOrEqual(120)
    expect(history!.height).toBeLessThan(30)
})

test('key actions remain reachable at phone and tablet widths', async ({ page }) => {
    for (const width of [320, 390, 768, 1024]) {
        await page.setViewportSize({ width, height: 900 })
        await page.locator('[data-page="keys"]').click()
        await expect(page.getByRole('columnheader', { name: 'API 密钥', exact: true })).toHaveCount(1)
        for (const selector of ['[data-key-action="copy"]', '[data-key-action="toggle"]', '[data-key-action="rename"]', '[data-key-menu]']) {
            const result = await page.locator(selector).evaluate((element) => {
                const r = element.getBoundingClientRect()
                return { left: r.left, right: r.right, width: r.width, viewport: innerWidth, hit: element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) }
            })
            expect(result.left).toBeGreaterThanOrEqual(0)
            expect(result.right).toBeLessThanOrEqual(result.viewport)
            expect(result.width).toBeGreaterThanOrEqual(24)
            expect(result.hit).toBe(true)
        }
        await page.locator('[data-key-menu]').click()
        await page.locator('[data-key-action="scope"]').click()
        await expect(page.locator('#drawer-title')).toHaveText('编辑 API 密钥授权范围')
        await page.locator('#drawer-close').click()
    }
})

test('drawer and long scope labels fit the usable viewport without clipping', async ({ page }) => {
    await page.route('**/v1/admin/config', route => route.fulfill({ json: {
        ...config, agents: [...agents, { ...agents[0], id: 'long', name: '跨团队验收-' + 'ResearchAssistant'.repeat(8) }]
    } }))
    await page.reload()
    for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 600 })
        await page.locator('[data-page="keys"]').click()
        await page.locator('#create-key').click()
        await page.locator('#all-agents').uncheck()
        const label = page.locator('.agent-scope .checkbox').last()
        await label.scrollIntoViewIfNeeded()
        const layout = await label.evaluate((element) => {
            const box = element.getBoundingClientRect(), text = element.querySelector('.scope-name')!.getBoundingClientRect()
            const drawer = document.querySelector('#drawer')!.getBoundingClientRect()
            return { textBottom: text.bottom, bottom: box.bottom, textRight: text.right, right: box.right, drawerLeft: drawer.left, drawerRight: drawer.right, viewport: innerWidth }
        })
        expect(layout.textBottom).toBeLessThanOrEqual(layout.bottom)
        expect(layout.textRight).toBeLessThanOrEqual(layout.right)
        expect(layout.drawerLeft).toBeGreaterThanOrEqual(0)
        expect(layout.drawerRight).toBeLessThanOrEqual(layout.viewport)
        await label.locator('input').check()
        await expect(label.locator('input')).toBeChecked()
        await expect(page.locator('#drawer-footer [type="submit"]')).toBeInViewport()
        await page.locator('#drawer-close').click()
        await page.locator('[data-page="agents"]').click()
        await page.locator('#add-agent').click()
        await expect(page.locator('#f-id')).toBeFocused()
        const labelVisible = await page.locator('label[for="f-id"]').evaluate(element => element.getBoundingClientRect().top >= document.querySelector('.drawer-body')!.getBoundingClientRect().top)
        expect(labelVisible).toBe(true)
        await page.locator('#drawer-close').click()
    }
})

test('a long form reveals its server error and a toast leaves footer actions reachable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 650 })
    await page.route('**/v1/admin/agents/test-agent', route => route.fulfill({ status: 400, json: { error: '工作区不存在，请检查路径。' } }))
    await page.locator('[data-page="agents"]').click()
    await page.locator('#add-agent').click()
    await page.locator('#f-id').fill('test-agent')
    await page.locator('#f-name').fill('表单错误可见性测试')
    await page.locator('#drawer-footer [type="submit"]').click()
    const error = page.locator('#drawer-form [data-form-error]')
    await expect(error).toContainText('工作区不存在')
    const fits = await error.evaluate(element => {
        const error = element.getBoundingClientRect(), body = document.querySelector('.drawer-body')!.getBoundingClientRect()
        return error.top >= body.top && error.bottom <= body.bottom
    })
    expect(fits).toBe(true)
    await page.locator('#drawer-close').click()
    await page.locator('[data-page="keys"]').click()
    await page.route('**/v1/admin/api-keys/key-1/reveal', route => route.fulfill({ json: { secret: 'nx_sk_layout_test_value_only' } }))
    await page.locator('[data-key-menu]').click()
    await page.locator('[data-key-action="reveal"]').click()
    await page.locator('#copy-secret').click()
    await expect(page.locator('#toast-status')).toContainText('已复制')
    await page.evaluate(async () => {
        const { toast } = await import('/ui/app/toast.js')
        for (let i = 0; i < 12; i++) toast('连续操作提示 ' + i)
    })
    await expect(page.locator('.toast').last()).toBeInViewport()
    await expect(page.locator('#copy-secret')).toBeInViewport()
    const cancel = page.locator('#drawer-footer [data-close-drawer]')
    const reachable = await cancel.evaluate(element => {
        const r = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    })
    expect(reachable).toBe(true)
    await cancel.click()
    await expect(page.locator('#drawer')).toBeHidden()
})
