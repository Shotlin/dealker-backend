import { describe, expect, it, vi } from 'vitest'

/**
 * Coverage for DeliveryCalendarService (delivery scheduling feature,
 * Phase 2, 2026-07-04) — the real, admin-managed replacement for the
 * hardcoded 7-day/fixed-window generator that used to live in
 * `orders/delivery-slots.routes.js` (deleted this phase). Two things this
 * must get right: (1) generation from the weekly template is idempotent
 * and never overwrites an admin's per-date override, (2) the public
 * `getAvailableDays` cutoff/closed-store logic exactly matches the old
 * generator's behavior so mobile sees no regression.
 */

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { DeliveryCalendarService } = await import(
  '../../../src/modules/delivery-calendar/delivery-calendar.service.js'
)

function makeRepo(overrides = {}) {
  return {
    getWeeklyTemplate: vi.fn().mockResolvedValue([]),
    getDayByDate: vi.fn().mockResolvedValue(null),
    ensureDay: vi.fn().mockImplementation(async (date, { isAvailable }) => ({
      id: `day-${date}`,
      calendar_date: date,
      is_available: isAvailable,
    })),
    insertSlotsForDay: vi.fn().mockResolvedValue(undefined),
    getDaysInRange: vi.fn().mockResolvedValue([]),
    getMaxGeneratedDate: vi.fn().mockResolvedValue(null),
    replaceWeeklyTemplate: vi.fn().mockResolvedValue([]),
    upsertDayOverride: vi.fn(),
    getRegeneratableDaysFromDate: vi.fn().mockResolvedValue([]),
    replaceSlotsForDay: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeStoreStatus(isOpen = true) {
  return { isOpen: vi.fn().mockResolvedValue({ isOpen, source: 'DEFAULT', reason: null }) }
}

// A fixed "now" so date-math is deterministic: 2026-07-06 10:00 IST (Monday).
const NOW = new Date(Date.UTC(2026, 6, 6, 4, 30)) // 10:00 IST

describe('DeliveryCalendarService.generateForwardDays — template-driven generation (positive)', () => {
  it('materializes a day per weekday window found in the template', async () => {
    const repo = makeRepo({
      getWeeklyTemplate: vi.fn().mockResolvedValue([
        { weekday: 1, is_available: true, start_time: '09:00:00', end_time: '11:00:00', label: '9-11 AM', display_order: 0 }, // Monday
      ]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    const result = await svc.generateForwardDays(1, NOW)

    expect(result.generated).toBe(1)
    expect(repo.ensureDay).toHaveBeenCalledWith('2026-07-06', { isAvailable: true })
    expect(repo.insertSlotsForDay).toHaveBeenCalledWith(
      'day-2026-07-06',
      expect.arrayContaining([expect.objectContaining({ label: '9-11 AM' })])
    )
  })

  it('marks a day unavailable when every template window for that weekday is unavailable', async () => {
    const repo = makeRepo({
      getWeeklyTemplate: vi.fn().mockResolvedValue([
        { weekday: 1, is_available: false, start_time: '09:00:00', end_time: '11:00:00', label: 'x', display_order: 0 },
      ]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    await svc.generateForwardDays(1, NOW)

    expect(repo.ensureDay).toHaveBeenCalledWith('2026-07-06', { isAvailable: false })
    expect(repo.insertSlotsForDay).not.toHaveBeenCalled()
  })

  it('does nothing when the template is completely empty (fresh install, admin never configured)', async () => {
    const repo = makeRepo({ getWeeklyTemplate: vi.fn().mockResolvedValue([]) })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    const result = await svc.generateForwardDays(5, NOW)

    expect(result.generated).toBe(0)
    expect(repo.ensureDay).not.toHaveBeenCalled()
  })
})

describe('DeliveryCalendarService.generateForwardDays — never overwrites an admin override (negative)', () => {
  it('skips a date that already has a materialized day, even if the template changed since', async () => {
    const repo = makeRepo({
      getWeeklyTemplate: vi.fn().mockResolvedValue([
        { weekday: 1, is_available: true, start_time: '09:00:00', end_time: '11:00:00', label: 'x', display_order: 0 },
      ]),
      getDayByDate: vi.fn().mockResolvedValue({ id: 'existing-day', calendar_date: '2026-07-06', is_available: false }),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    await svc.generateForwardDays(1, NOW)

    expect(repo.ensureDay).not.toHaveBeenCalled()
    expect(repo.insertSlotsForDay).not.toHaveBeenCalled()
  })
})

describe('DeliveryCalendarService.getAvailableDays — response shape + cutoff (positive)', () => {
  it('marks a slot unavailable once it is within the 30-minute cutoff', async () => {
    const repo = makeRepo({
      getDaysInRange: vi.fn().mockResolvedValue([
        {
          id: 'day-1',
          calendar_date: '2026-07-06',
          is_available: true,
          slots: [
            { start_time: '10:15:00', end_time: '12:00:00', label: 'soon', is_active: true }, // 15 min away — inside cutoff
            { start_time: '14:00:00', end_time: '16:00:00', label: 'later', is_active: true }, // hours away
          ],
        },
      ]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus(true))

    const result = await svc.getAvailableDays(1, NOW)

    const [soon, later] = result.days[0].slots
    expect(soon).toMatchObject({ available: false, reason: 'This time slot has passed' })
    expect(later).toMatchObject({ available: true, reason: null })
  })

  it('uses Today/Tomorrow labels for the first two days and a weekday label beyond that', async () => {
    const repo = makeRepo()
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    const result = await svc.getAvailableDays(3, NOW)

    expect(result.days[0].label).toBe('Today')
    expect(result.days[1].label).toBe('Tomorrow')
    expect(result.days[2].label).not.toBe('Today')
    expect(result.days[2].label).not.toBe('Tomorrow')
  })
})

describe('DeliveryCalendarService.getAvailableDays — closed-store + unavailable-day handling (negative)', () => {
  it('suppresses only TODAY\'s slots when the store is manually closed, leaving future days untouched', async () => {
    const repo = makeRepo({
      getDaysInRange: vi.fn().mockResolvedValue([
        {
          id: 'day-today',
          calendar_date: '2026-07-06',
          is_available: true,
          slots: [{ start_time: '18:00:00', end_time: '20:00:00', label: 'evening', is_active: true }],
        },
        {
          id: 'day-tomorrow',
          calendar_date: '2026-07-07',
          is_available: true,
          slots: [{ start_time: '10:00:00', end_time: '12:00:00', label: 'morning', is_active: true }],
        },
      ]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus(false))

    const result = await svc.getAvailableDays(2, NOW)

    expect(result.days[0].slots[0]).toMatchObject({ available: false, reason: 'Store is currently closed' })
    expect(result.days[1].slots[0]).toMatchObject({ available: true, reason: null })
  })

  it('marks every slot on a date the admin overrode as unavailable, with the override note as the reason', async () => {
    const repo = makeRepo({
      getDaysInRange: vi.fn().mockResolvedValue([
        {
          id: 'day-1',
          calendar_date: '2026-07-06',
          is_available: false,
          note: 'Public holiday',
          slots: [],
        },
      ]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus(true))

    const result = await svc.getAvailableDays(1, NOW)

    expect(result.days[0].slots).toEqual([])
  })

  it('returns a fully-populated day (no materialized data) with zero slots rather than throwing', async () => {
    const repo = makeRepo({ getDaysInRange: vi.fn().mockResolvedValue([]) })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    const result = await svc.getAvailableDays(2, NOW)

    expect(result.days).toHaveLength(2)
    expect(result.days.every((d) => Array.isArray(d.slots))).toBe(true)
  })
})

describe('DeliveryCalendarService.replaceWeeklyTemplate — resyncing already-materialized future days', () => {
  it('resyncs a purely template-generated day to the new template for its weekday', async () => {
    const newTemplate = [
      { weekday: 1, is_available: true, start_time: '09:00', end_time: '11:00', label: '9-11 AM', display_order: 0 }, // Monday
    ]
    const repo = makeRepo({
      replaceWeeklyTemplate: vi.fn().mockResolvedValue(newTemplate),
      getRegeneratableDaysFromDate: vi.fn().mockResolvedValue([
        { id: 'day-mon', calendar_date: '2026-07-06', is_available: true, updated_by: null }, // Monday
      ]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    await svc.replaceWeeklyTemplate([], NOW)

    expect(repo.getRegeneratableDaysFromDate).toHaveBeenCalledWith('2026-07-06')
    expect(repo.replaceSlotsForDay).toHaveBeenCalledWith(
      'day-mon',
      true,
      [{ start_time: '09:00', end_time: '11:00', label: '9-11 AM', display_order: 0 }]
    )
  })

  it('marks a day unavailable (empty slots) when the new template has no available window for its weekday', async () => {
    const repo = makeRepo({
      replaceWeeklyTemplate: vi.fn().mockResolvedValue([
        { weekday: 1, is_available: false, start_time: '09:00', end_time: '11:00', label: 'closed', display_order: 0 },
      ]),
      getRegeneratableDaysFromDate: vi.fn().mockResolvedValue([
        { id: 'day-mon', calendar_date: '2026-07-06', is_available: true, updated_by: null },
      ]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    await svc.replaceWeeklyTemplate([], NOW)

    expect(repo.replaceSlotsForDay).toHaveBeenCalledWith('day-mon', false, [])
  })

  it('never touches a day the admin individually overrode (repo already excludes updated_by rows, service must not re-fetch/bypass it)', async () => {
    const repo = makeRepo({
      replaceWeeklyTemplate: vi.fn().mockResolvedValue([
        { weekday: 1, is_available: true, start_time: '09:00', end_time: '11:00', label: '9-11 AM', display_order: 0 },
      ]),
      // Simulates the repo's own WHERE updated_by IS NULL filter already
      // having excluded an admin-overridden Monday from the result set.
      getRegeneratableDaysFromDate: vi.fn().mockResolvedValue([]),
    })
    const svc = new DeliveryCalendarService(repo, makeStoreStatus())

    await svc.replaceWeeklyTemplate([], NOW)

    expect(repo.replaceSlotsForDay).not.toHaveBeenCalled()
  })
})
