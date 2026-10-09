/** Pure date-range helper for the command centre (no database access). */

const DAY = 86400000

export const PERIODS = ['today', 'week', 'month', 'year']

export function periodRange(period, now = new Date()) {
  const p = PERIODS.includes(period) ? period : 'week'
  let from
  if (p === 'today') { from = new Date(now); from.setHours(0, 0, 0, 0) }
  else from = new Date(now.getTime() - { week: 7, month: 30, year: 365 }[p] * DAY)
  const len = now.getTime() - from.getTime()
  return { period: p, from, to: now, prevFrom: new Date(from.getTime() - len), prevTo: from }
}

