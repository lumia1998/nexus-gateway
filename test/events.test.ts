import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionEventLog } from '../src/events.js'

test('event replay detects expired, invalid and future cursors without pretending to recover history', () => {
    const log = new SessionEventLog('session', 2)
    assert.deepEqual(log.replay().events, [])
    assert.equal(log.replay().latestId, '0')
    for (let n = 0; n < 4; n++) log.append('assistant_chunk', { text: String(n) })
    assert.equal(log.replay().reset?.reason, 'expired')
    assert.equal(log.replay('1').reset?.reason, 'expired')
    assert.deepEqual(log.replay('1').events, [])
    assert.equal(log.replay('1').earliestId, '3')
    assert.equal(log.replay('1').latestId, '4')
    assert.deepEqual(log.replay('2').events.map((e) => e.id), ['3', '4'])
    assert.deepEqual(log.replay('4').events, [])
    assert.equal(log.replay('5').reset?.reason, 'ahead')
    for (const cursor of ['', '-1', '1.5', 'NaN', '1e0', ' 2', '9007199254740992']) {
        assert.equal(log.replay(cursor).reset?.reason, 'invalid', cursor)
    }
    const event = log.replay('2').events[0]
    ;(event.data as { text: string }).text = 'mutated'
    assert.equal((log.replay('2').events[0].data as { text: string }).text, '2')
})
