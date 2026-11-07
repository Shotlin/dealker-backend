import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// config/env.js validates process.env on import; give it throwaway values when the shell has none.
vi.hoisted(() => {
  const d = { JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64), COOKIE_SECRET: 'c'.repeat(32),
    DB_NAME: 'x', DB_USER: 'x', DB_PASSWORD: 'x' }
  for (const [k, v] of Object.entries(d)) process.env[k] ||= v
})

// Count every round-trip the auth path makes.
const queryMock = vi.hoisted(() => vi.fn())
vi.mock('../../../src/config/database.js', () => ({ query: queryMock }))
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import Fastify from 'fastify'
import authPlugin from '../../../src/plugins/auth.plugin.js'
import {
  clearAuthContextCache,
  invalidateAuthContext,
  loadAuthContext,
} from '../../../src/utils/auth-context.js'

const USER = '11111111-1111-1111-1111-111111111111'
const SESSION = '22222222-2222-2222-2222-222222222222'

/** What the single auth statement returns. */
const ctxRow = (over = {}) => ({
  found: true, is_blocked: false, session_version: 3, platform_role: null, session_active: true, ...over,
})

let app
const sign = (payload) => app.jwt.sign({ id: USER, role: 'VENDOR_OWNER', session_version: 3, sessionId: SESSION, ...payload })
const hit = (token) => app.inject({ method: 'GET', url: '/ping', headers: { authorization: `Bearer ${token}` } })

/** Route the auth statement + the fire-and-forget stamp. */
function dbReturns(row) {
  queryMock.mockImplementation(async (sql) => {
    if (/UPDATE users SET last_active_at/.test(sql)) return { rows: [], rowCount: 0 }
    return { rows: [row] }
  })
}
const authSelects = () => queryMock.mock.calls.filter(([sql]) => /LEFT JOIN users u/.test(sql))
const stamps = () => queryMock.mock.calls.filter(([sql]) => /UPDATE users SET last_active_at/.test(sql))

describe('fastify.authenticate — collapsed + cached auth lookups', () => {
  beforeAll(async () => {
    process.env.AUTH_CACHE_TTL_MS = '5000' // the cache is off under vitest by default; opt in for these tests
    app = Fastify()
    await app.register(authPlugin)
    app.get('/ping', { preHandler: [app.authenticate] }, async (req) => ({ ok: true, role: req.auth.role, userId: req.userId }))
    await app.ready()
  })
  afterAll(async () => {
    delete process.env.AUTH_CACHE_TTL_MS
    await app.close()
  })
  beforeEach(() => {
    queryMock.mockReset()
    clearAuthContextCache()
  })

  it('answers all three gates with ONE statement per request', async () => {
    dbReturns(ctxRow())
    const res = await hit(sign())
    expect(res.statusCode).toBe(200)
    expect(authSelects()).toHaveLength(1) // used to be users + user_device_sessions = 2 sequential queries
  })

  it('a burst of 16 parallel requests costs one lookup and one last_active stamp', async () => {
    dbReturns(ctxRow())
    const token = sign()
    const all = await Promise.all(Array.from({ length: 16 }, () => hit(token)))
    expect(all.every((r) => r.statusCode === 200)).toBe(true)
    expect(authSelects()).toHaveLength(1)
    expect(stamps()).toHaveLength(1)
  })

  it('serves the next requests from memory', async () => {
    dbReturns(ctxRow())
    const token = sign()
    await hit(token)
    await hit(token)
    await hit(token)
    expect(authSelects()).toHaveLength(1)
  })

  it('still rejects a blocked account (403)', async () => {
    dbReturns(ctxRow({ is_blocked: true }))
    const res = await hit(sign())
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('ACCOUNT_BLOCKED')
  })

  it('still rejects a revoked / expired device session (401)', async () => {
    dbReturns(ctxRow({ session_active: false }))
    const res = await hit(sign())
    expect(res.statusCode).toBe(401)
    expect(res.json().message).toMatch(/revoked or expired/i)
  })

  it('still rejects a stale session_version (401)', async () => {
    dbReturns(ctxRow({ session_version: 4 })) // user changed password since this token was issued
    const res = await hit(sign())
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('SESSION_INVALID')
  })

  it('does not ask about device sessions when the token has none', async () => {
    dbReturns(ctxRow({ session_active: null }))
    const res = await hit(sign({ sessionId: undefined }))
    expect(res.statusCode).toBe(200)
    expect(authSelects()[0][1]).toEqual([USER]) // no session id param
  })

  it('a user row that does not exist falls back to the token role, like before', async () => {
    dbReturns(ctxRow({ found: false, is_blocked: null, session_version: null, session_active: true }))
    const res = await hit(sign())
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('VENDOR_OWNER')
  })

  it('a block applied through invalidateAuthContext() takes effect immediately, not after the TTL', async () => {
    dbReturns(ctxRow())
    const token = sign()
    expect((await hit(token)).statusCode).toBe(200)

    dbReturns(ctxRow({ is_blocked: true }))
    expect((await hit(token)).statusCode).toBe(200) // still cached — this is the (≤5 s) staleness window
    invalidateAuthContext(USER)
    expect((await hit(token)).statusCode).toBe(403)
  })

  it('a DB failure is a 401, never a 500 and never cached', async () => {
    queryMock.mockRejectedValueOnce(new Error('pool exhausted'))
    const token = sign()
    expect((await hit(token)).statusCode).toBe(401)
    dbReturns(ctxRow())
    expect((await hit(token)).statusCode).toBe(200)
  })

  it('loadAuthContext() keys sessions separately for the same user', async () => {
    dbReturns(ctxRow())
    await loadAuthContext(USER, SESSION)
    await loadAuthContext(USER, null)
    expect(authSelects()).toHaveLength(2)
  })
})
