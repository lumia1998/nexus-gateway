import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const KEY_LENGTH = 64
const PASSWORD_MIN_LENGTH = 12

export async function hashAdminPassword(input: string) {
    const password = validateAdminPassword(input)
    const salt = randomBytes(16)
    const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer
    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`
}

export async function verifyAdminPassword(input: string, encoded?: string) {
    if (!encoded) return false
    const [algorithm, saltValue, hashValue, extra] = encoded.split('$')
    if (algorithm !== 'scrypt' || !saltValue || !hashValue || extra !== undefined) {
        return false
    }
    try {
        const expected = Buffer.from(hashValue, 'base64url')
        if (expected.length !== KEY_LENGTH) return false
        const actual = (await scrypt(
            input,
            Buffer.from(saltValue, 'base64url'),
            expected.length
        )) as Buffer
        return timingSafeEqual(actual, expected)
    } catch {
        return false
    }
}

export function validateAdminPassword(input: string) {
    const value = typeof input === 'string' ? input : ''
    if (value.length < PASSWORD_MIN_LENGTH) {
        throw new Error(`Console Password must contain at least ${PASSWORD_MIN_LENGTH} characters`)
    }
    if (Buffer.byteLength(value, 'utf8') > 1024) {
        throw new Error('Console Password must not exceed 1024 bytes')
    }
    if (/\u0000/.test(value)) throw new Error('Console Password must not contain NUL bytes')
    return value
}

export class AdminSessionStore {
    // Stored keys are SHA-256 digests of the raw session id so a timing attack
    // on Map lookup / string comparison cannot learn a valid prefix. The raw
    // id never leaves the HttpOnly cookie.
    private readonly sessions = new Map<string, number>()

    constructor(private readonly ttlMs: number) {}

    create() {
        this.cleanup()
        const raw = randomBytes(32).toString('base64url')
        this.sessions.set(digest(raw), Date.now() + this.ttlMs)
        return raw
    }

    has(id: string) {
        if (typeof id !== 'string' || !id) return false
        const key = digest(id)
        let match: string | undefined
        // Walk every stored digest in constant time. `timingSafeEqual` requires
        // equal-length inputs, which is guaranteed because all digests have the
        // same byte length.
        for (const stored of this.sessions.keys()) {
            const a = Buffer.from(stored, 'hex')
            const b = Buffer.from(key, 'hex')
            if (a.length === b.length && timingSafeEqual(a, b)) match = stored
        }
        if (!match) return false
        const expiresAt = this.sessions.get(match)!
        if (expiresAt <= Date.now()) {
            this.sessions.delete(match)
            return false
        }
        return true
    }

    delete(id: string) {
        if (typeof id !== 'string' || !id) return
        this.sessions.delete(digest(id))
    }

    clear() {
        this.sessions.clear()
    }

    private cleanup() {
        const now = Date.now()
        for (const [id, expiresAt] of this.sessions) {
            if (expiresAt <= now) this.sessions.delete(id)
        }
    }
}

function digest(value: string) {
    return createHash('sha256').update(value, 'utf8').digest('hex')
}
