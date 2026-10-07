import { describe, expect, it, vi, afterEach } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  evaluateLocationFreshness,
  logStaleLocationSkips,
  applyPoolCap,
} from '../../../src/workers/dispatch-eligibility.js'
import { logger } from '../../../src/config/logger.js'

afterEach(() => {
  vi.clearAllMocks()
})

const NOW = Date.parse('2026-09-25T12:00:00.000Z')

describe('evaluateLocationFreshness', () => {
  it('accepts a fresh Redis fix', () => {
    const result = evaluateLocationFreshness({
      redisUpdatedAt: NOW - 60 * 1000,
      dbLocationUpdatedAt: null,
      nowMs: NOW,
    })
    expect(result.fresh).toBe(true)
    expect(result.source).toBe('redis')
    expect(result.ageSeconds).toBe(60)
  })

  it('rejects a Redis fix older than the staleness window', () => {
    const result = evaluateLocationFreshness({
      redisUpdatedAt: NOW - 11 * 60 * 1000,
      dbLocationUpdatedAt: null,
      nowMs: NOW,
    })
    expect(result.fresh).toBe(false)
    expect(result.source).toBe('redis')
  })

  it('falls back to the DB timestamp when Redis has no entry', () => {
    const result = evaluateLocationFreshness({
      redisUpdatedAt: null,
      dbLocationUpdatedAt: '2026-09-25T11:55:00.000Z',
      nowMs: NOW,
    })
    expect(result.fresh).toBe(true)
    expect(result.source).toBe('db')
    expect(result.ageSeconds).toBe(300)
  })

  it('rejects a stale DB fallback fix', () => {
    const result = evaluateLocationFreshness({
      redisUpdatedAt: null,
      dbLocationUpdatedAt: '2026-09-25T11:00:00.000Z',
      nowMs: NOW,
    })
    expect(result.fresh).toBe(false)
    expect(result.source).toBe('db')
  })

  it('rejects riders with no fix at all', () => {
    const result = evaluateLocationFreshness({
      redisUpdatedAt: null,
      dbLocationUpdatedAt: null,
      nowMs: NOW,
    })
    expect(result.fresh).toBe(false)
    expect(result.source).toBeNull()
    expect(result.ageSeconds).toBeNull()
  })

  it('rejects a DB timestamp in the future (clock skew) rather than accepting blindly', () => {
    const result = evaluateLocationFreshness({
      redisUpdatedAt: null,
      dbLocationUpdatedAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
      nowMs: NOW,
    })
    expect(result.fresh).toBe(false)
  })

  it('honours an injected staleness window', () => {
    const result = evaluateLocationFreshness({
      redisUpdatedAt: null,
      dbLocationUpdatedAt: '2026-09-25T11:56:00.000Z',
      nowMs: NOW,
      staleMinutes: 5,
    })
    expect(result.fresh).toBe(true)
    expect(result.ageSeconds).toBe(240)
  })
})

describe('logStaleLocationSkips', () => {
  it('does not log when nothing was skipped', () => {
    logStaleLocationSkips({ skipped: 0, total: 5, orderId: 'o1', source: 'test' })
    expect(vi.mocked(logger.info)).not.toHaveBeenCalled()
  })

  it('logs once with skip counts when candidates were dropped', () => {
    logStaleLocationSkips({ skipped: 3, total: 9, orderId: 'o1', source: 'test' })
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info).mock.calls[0][0]).toMatchObject({
      skipped: 3,
      total: 9,
      orderId: 'o1',
    })
  })
})

describe('applyPoolCap (architecture §9 configurable nearest pool)', () => {
  const pool = Array.from({ length: 5 }, (_, i) => ({ riderId: `r-${i}`, distanceKm: i }))

  it('truncates to the configured pool size, keeping the nearest', () => {
    const capped = applyPoolCap(pool, 2)
    expect(capped).toHaveLength(2)
    expect(capped.map((c) => c.riderId)).toEqual(['r-0', 'r-1'])
    // input untouched
    expect(pool).toHaveLength(5)
  })

  it('returns the same array untouched when under the cap', () => {
    expect(applyPoolCap(pool, 10)).toBe(pool)
  })

  it('treats a non-positive cap as unlimited', () => {
    expect(applyPoolCap(pool, 0)).toBe(pool)
    expect(applyPoolCap(pool, -3)).toBe(pool)
    expect(applyPoolCap(pool, Number.NaN)).toBe(pool)
  })

  it('returns an empty array for non-array input', () => {
    expect(applyPoolCap(null, 5)).toEqual([])
  })
})
