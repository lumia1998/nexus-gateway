import assert from 'node:assert/strict'
import test from 'node:test'
import { QuotaExceededError, QuotaManager } from '../src/server/quota.js'

test('session quota rejects a concurrent reservation and releases after failure', () => {
    const quota = new QuotaManager({
        quotas: {
            maxSessionsPerKey: 1,
            maxRunningRunsPerKey: 1,
            maxSsePerKey: 1,
            maxUploadBytesPerKey: 1024
        }
    })
    const first = quota.reserveSession('key')
    assert.throws(
        () => quota.reserveSession('key'),
        (error: unknown) => error instanceof QuotaExceededError && error.quota === 'sessions'
    )
    first()
    const afterFailure = quota.reserveSession('key')
    assert.equal(quota.usageFor('key').sessions, 1)
    afterFailure()
    assert.equal(quota.usageFor('key').sessions, 0)
})

test('terminal running runs release their slot for the next run', () => {
    const quota = new QuotaManager({
        quotas: {
            maxSessionsPerKey: 2,
            maxRunningRunsPerKey: 1,
            maxSsePerKey: 1,
            maxUploadBytesPerKey: 1024
        }
    })
    const first = quota.reserveRunningRun('key', 'session-1')
    assert.equal(quota.usageFor('key').runningRuns, 1)
    quota.finishRun('session-1', 'key')
    assert.equal(quota.usageFor('key').runningRuns, 0)
    const second = quota.reserveRunningRun('key', 'session-2')
    second()
    first()
    assert.equal(quota.usageFor('key').runningRuns, 0)
})
