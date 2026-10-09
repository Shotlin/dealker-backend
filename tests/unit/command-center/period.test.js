import { describe, expect, it } from 'vitest'
import { periodRange } from '../../../src/modules/command-center/command-center.period.js'

describe('periodRange', () => {
  const now = new Date('2026-10-09T10:30:00')
  it('today starts at midnight and the previous period has the same length', () => {
    const r = periodRange('today', now)
    expect(r.from.getHours()).toBe(0)
    expect(r.to.getTime() - r.from.getTime()).toBe(r.prevTo.getTime() - r.prevFrom.getTime())
    expect(r.prevTo.getTime()).toBe(r.from.getTime())
  })
  it('week / month / year look back 7 / 30 / 365 days', () => {
    for (const [p, d] of [['week', 7], ['month', 30], ['year', 365]]) {
      const r = periodRange(p, now)
      expect(Math.round((r.to - r.from) / 86400000)).toBe(d)
      expect(r.prevTo.getTime()).toBe(r.from.getTime())
    }
  })
  it('an unknown period falls back to week', () => {
    expect(periodRange('decade', now).period).toBe('week')
  })
})
