/**
 * Date-range + comparison helpers for the Business Overview.
 *
 * All day boundaries are Asia/Kolkata (the business operates in IST), but the
 * returned instants are plain `Date`s so they bind to `timestamptz` params.
 * Pure functions — unit tested without a database.
 */

const IST_OFFSET_MIN = 330
const DAY_MS = 86_400_000

export const RANGE_KEYS = ['today', 'yesterday', '7d', '30d', 'custom']

/** Midnight (IST) of the day containing `instant`, as a UTC Date. */
export function startOfIstDay(instant) {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MIN * 60_000)
  shifted.setUTCHours(0, 0, 0, 0)
  return new Date(shifted.getTime() - IST_OFFSET_MIN * 60_000)
}

/** Parses 'YYYY-MM-DD' as midnight IST. Returns null when invalid. */
export function parseIstDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const d = new Date(`${value}T00:00:00+05:30`)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Resolves a range key into `{ from, to, previousFrom, previousTo, days, label }`.
 * `to` is exclusive. The previous window is the immediately preceding window of
 * identical length, so every % change compares like with like.
 */
export function resolveRange({ range = '7d', from, to } = {}, now = new Date()) {
  const todayStart = startOfIstDay(now)
  let start
  let end
  let label

  switch (range) {
    case 'today':
      start = todayStart
      end = new Date(todayStart.getTime() + DAY_MS)
      label = 'Today'
      break
    case 'yesterday':
      start = new Date(todayStart.getTime() - DAY_MS)
      end = todayStart
      label = 'Yesterday'
      break
    case '30d':
      start = new Date(todayStart.getTime() - 29 * DAY_MS)
      end = new Date(todayStart.getTime() + DAY_MS)
      label = 'Last 30 days'
      break
    case 'custom': {
      const f = parseIstDate(from)
      const t = parseIstDate(to)
      if (!f || !t || t < f) {
        const err = new Error('Custom range needs valid from/to dates (YYYY-MM-DD) with to >= from')
        err.statusCode = 400
        err.code = 'INVALID_RANGE'
        throw err
      }
      start = f
      end = new Date(t.getTime() + DAY_MS)
      label = `${from} → ${to}`
      break
    }
    case '7d':
    default:
      start = new Date(todayStart.getTime() - 6 * DAY_MS)
      end = new Date(todayStart.getTime() + DAY_MS)
      label = 'Last 7 days'
  }

  const lengthMs = end.getTime() - start.getTime()
  if (lengthMs > 366 * DAY_MS) {
    const err = new Error('Range cannot exceed 366 days')
    err.statusCode = 400
    err.code = 'INVALID_RANGE'
    throw err
  }
  return {
    from: start,
    to: end,
    previousFrom: new Date(start.getTime() - lengthMs),
    previousTo: start,
    days: Math.round(lengthMs / DAY_MS),
    label,
  }
}

/** % change vs previous. null when there is no meaningful baseline. */
export function pctChange(current, previous) {
  const c = Number(current)
  const p = Number(previous)
  if (!Number.isFinite(c) || !Number.isFinite(p)) return null
  if (p === 0) return c === 0 ? 0 : null
  return Math.round(((c - p) / Math.abs(p)) * 1000) / 10
}

/** `{ value, previous, change_pct }` metric envelope used by every KPI. */
export function metric(current, previous) {
  const value = current == null ? null : Number(current)
  const prev = previous == null ? null : Number(previous)
  return { value, previous: prev, change_pct: value == null || prev == null ? null : pctChange(value, prev) }
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
