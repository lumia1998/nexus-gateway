import { defineConfig } from '@playwright/test'

export default defineConfig({
    testDir: './test/webui',
    fullyParallel: true,
    workers: 2,
    use: { viewport: { width: 1280, height: 900 }, trace: 'retain-on-failure' },
    reporter: 'list'
})
