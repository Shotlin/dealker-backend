import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Coverage for the store-open/closed evaluator (2026-07-03, delivery
 * scheduling feature Phase 1) — this is genuinely new logic; nothing in the
 * codebase computed "is the store open right now" before migration 071
 * (confirmed via exhaustive grep). Priority is manual_override_status (if
 * set) > weekly_hours > fail-open. Fail-open is a deliberate, confirmed
 * product decision: missing/malformed weekly_hours must never silently
 * block ASAP ordering the moment this ships.
 */

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const mockIoEmit = vi.fn()
const mockIoTo = vi.fn(() => ({ emit: mockIoEmit }))
const getSocketIoMock = vi.fn(() => ({ to: mockIoTo }))
vi.mock('../../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: () => getSocketIoMock(),
}))

const emitAuditMock = vi.fn()
vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: (...args) => emitAuditMock(...args),
}))

const { StoreStatusService } = await import('../../../src/modules/store-status/store-status.service.js')

function service(row) {
  const repo = { getStatus: vi.fn().mockResolvedValue(row) }
  return new StoreStatusService(repo)
}

// 2026-07-06 is a Monday. All times below are IST.
function istInstant(hour, minute, { day = 6 } = {}) {
  // day=6 → 2026-07-06 (Monday). UTC = IST - 5:30.
  return new Date(Date.UTC(2026, 6, day, hour - 5, minute - 30))
}

describe('StoreStatusService.isOpen — weekly schedule (positive)', () => {
  it('is open when the current IST time falls inside the configured window', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: false } },
    })

    const result = await svc.isOpen(istInstant(14, 0))

    expect(result).toMatchObject({ isOpen: true, source: 'WEEKLY_SCHEDULE' })
  })

  it('is closed when the current IST time is before the opening time', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: false } },
    })

    const result = await svc.isOpen(istInstant(8, 59))

    expect(result).toMatchObject({ isOpen: false, source: 'WEEKLY_SCHEDULE' })
  })

  it('is closed exactly at the closing minute (end exclusive)', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: false } },
    })

    const result = await svc.isOpen(istInstant(21, 0))

    expect(result.isOpen).toBe(false)
  })

  it('is open at the exact opening minute (start inclusive)', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: false } },
    })

    const result = await svc.isOpen(istInstant(9, 0))

    expect(result.isOpen).toBe(true)
  })

  it('respects an explicit closed:true flag for the day regardless of open/close times', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: true } },
    })

    const result = await svc.isOpen(istInstant(14, 0))

    expect(result).toMatchObject({ isOpen: false, source: 'WEEKLY_SCHEDULE' })
  })

  it('correctly rolls over to the next IST weekday near midnight UTC', async () => {
    // 2026-07-06 23:58 UTC = 2026-07-07 05:28 IST (Tuesday morning)
    const svc = service({
      manual_override_status: null,
      weekly_hours: { tuesday: { open: '05:00', close: '21:00', closed: false } },
    })

    const nearMidnightUtc = new Date(Date.UTC(2026, 6, 6, 23, 58))
    const result = await svc.isOpen(nearMidnightUtc)

    expect(result).toMatchObject({ isOpen: true, source: 'WEEKLY_SCHEDULE' })
  })
})

describe('StoreStatusService.isOpen — manual override takes priority (positive)', () => {
  it('override CLOSED wins even during a weekly-open window', async () => {
    const svc = service({
      manual_override_status: 'CLOSED',
      manual_override_note: 'Unexpected closure',
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: false } },
    })

    const result = await svc.isOpen(istInstant(14, 0))

    expect(result).toMatchObject({
      isOpen: false,
      source: 'MANUAL_OVERRIDE',
      reason: 'Unexpected closure',
    })
  })

  it('override OPEN wins even during a weekly-closed window', async () => {
    const svc = service({
      manual_override_status: 'OPEN',
      manual_override_note: null,
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: true } },
    })

    const result = await svc.isOpen(istInstant(14, 0))

    expect(result).toMatchObject({ isOpen: true, source: 'MANUAL_OVERRIDE' })
  })
})

describe('StoreStatusService.isOpen — fail-open on missing/malformed data (negative)', () => {
  it('fails open when weekly_hours is an empty object', async () => {
    const svc = service({ manual_override_status: null, weekly_hours: {} })

    const result = await svc.isOpen(istInstant(14, 0))

    expect(result).toMatchObject({ isOpen: true, source: 'DEFAULT' })
  })

  it('fails open when the current weekday has no entry at all', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { tuesday: { open: '09:00', close: '21:00', closed: false } },
    })

    const result = await svc.isOpen(istInstant(14, 0)) // Monday, no entry

    expect(result).toMatchObject({ isOpen: true, source: 'DEFAULT' })
  })

  it('fails open when open/close times are malformed strings', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { monday: { open: 'not-a-time', close: '21:00', closed: false } },
    })

    const result = await svc.isOpen(istInstant(14, 0))

    expect(result).toMatchObject({ isOpen: true, source: 'DEFAULT' })
  })

  it('fails open (does not throw) when the store_status row itself is missing', async () => {
    const svc = service(null)

    const result = await svc.isOpen(istInstant(14, 0))

    expect(result).toMatchObject({ isOpen: true, source: 'DEFAULT' })
  })
})

describe('StoreStatusService.getNext7DaysAvailability (Phase 3, mobile store-hours surface)', () => {
  it('returns 7 days evaluated against the weekly schedule when there is no override', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: {
        monday: { open: '09:00', close: '21:00', closed: false },
        tuesday: { open: '09:00', close: '21:00', closed: false },
        wednesday: { open: '09:00', close: '21:00', closed: false },
        thursday: { open: '09:00', close: '21:00', closed: false },
        friday: { open: '09:00', close: '21:00', closed: false },
        saturday: { open: '09:00', close: '21:00', closed: false },
        sunday: { closed: true },
      },
    })

    const days = await svc.getNext7DaysAvailability(istInstant(10, 0)) // Monday

    expect(days).toHaveLength(7)
    expect(days[0]).toMatchObject({ weekday: 'monday', isOpen: true, open: '09:00', close: '21:00' })
    // day=6 is Monday 2026-07-06, so offset 6 lands on Sunday 2026-07-12.
    expect(days[6]).toMatchObject({ weekday: 'sunday', isOpen: false })
  })

  it("applies the manual override only to today's entry, not future days", async () => {
    const svc = service({
      manual_override_status: 'CLOSED',
      manual_override_note: 'Unplanned closure',
      weekly_hours: {
        monday: { open: '09:00', close: '21:00', closed: false },
        tuesday: { open: '09:00', close: '21:00', closed: false },
      },
    })

    const days = await svc.getNext7DaysAvailability(istInstant(10, 0)) // Monday

    expect(days[0]).toMatchObject({ weekday: 'monday', isOpen: false, reason: 'Unplanned closure' })
    expect(days[1]).toMatchObject({ weekday: 'tuesday', isOpen: true, open: '09:00', close: '21:00' })
  })

  it('fails open for days with missing/malformed weekly-hours entries', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: { monday: { open: '09:00', close: '21:00', closed: false } },
    })

    const days = await svc.getNext7DaysAvailability(istInstant(10, 0)) // Monday

    // tuesday has no entry at all — must fail open, not report closed.
    expect(days[1]).toMatchObject({ weekday: 'tuesday', isOpen: true, open: null, close: null })
  })
})

describe('StoreStatusService — closed banner image (Phase 4, dashboard-uploadable "we are closed" banner)', () => {
  it('getClosedBannerImageUrl() returns the stored URL', async () => {
    const svc = service({ manual_override_status: null, weekly_hours: {}, closed_banner_image_url: 'https://cdn.example/closed.png' })

    const url = await svc.getClosedBannerImageUrl()

    expect(url).toBe('https://cdn.example/closed.png')
  })

  it('getClosedBannerImageUrl() returns null when never set', async () => {
    const svc = service({ manual_override_status: null, weekly_hours: {}, closed_banner_image_url: null })

    const url = await svc.getClosedBannerImageUrl()

    expect(url).toBeNull()
  })

  it('updateClosedBannerImage() delegates to the repository', async () => {
    const repo = {
      getStatus: vi.fn(),
      updateClosedBannerImage: vi.fn().mockResolvedValue({ id: 'row-1', closed_banner_image_url: 'https://cdn.example/new.png' }),
    }
    const svc = new StoreStatusService(repo)

    const result = await svc.updateClosedBannerImage('https://cdn.example/new.png')

    expect(repo.updateClosedBannerImage).toHaveBeenCalledWith('https://cdn.example/new.png')
    expect(result.closed_banner_image_url).toBe('https://cdn.example/new.png')
  })

  it('getFullStatus() includes closedBannerImageUrl alongside weeklyHours', async () => {
    const svc = service({
      manual_override_status: null,
      weekly_hours: {},
      closed_banner_image_url: 'https://cdn.example/closed.png',
    })

    const result = await svc.getFullStatus()

    expect(result.closedBannerImageUrl).toBe('https://cdn.example/closed.png')
  })
})

describe('StoreStatusService — realtime broadcast on change (instant-reflect fix, 2026-07-04)', () => {
  beforeEach(() => {
    mockIoEmit.mockClear()
    mockIoTo.mockClear()
    getSocketIoMock.mockClear()
  })

  it('setOverride() broadcasts to the themes:live room so every connected app refetches instantly', async () => {
    const repo = { setOverride: vi.fn().mockResolvedValue({ id: 'row-1' }) }
    const svc = new StoreStatusService(repo)

    await svc.setOverride({ status: 'CLOSED', note: 'test', adminId: 'admin-1' })

    expect(mockIoTo).toHaveBeenCalledWith('themes:live')
    expect(mockIoEmit).toHaveBeenCalledWith('store:status:update', expect.objectContaining({ timestamp: expect.any(String) }))
  })

  it('updateWeeklyHours() broadcasts too', async () => {
    const repo = { updateWeeklyHours: vi.fn().mockResolvedValue({ id: 'row-1' }) }
    const svc = new StoreStatusService(repo)

    await svc.updateWeeklyHours({})

    expect(mockIoEmit).toHaveBeenCalledWith('store:status:update', expect.any(Object))
  })

  it('updateClosedBannerImage() broadcasts too', async () => {
    const repo = { updateClosedBannerImage: vi.fn().mockResolvedValue({ id: 'row-1' }) }
    const svc = new StoreStatusService(repo)

    await svc.updateClosedBannerImage('https://cdn.example/new.png')

    expect(mockIoEmit).toHaveBeenCalledWith('store:status:update', expect.any(Object))
  })

  it('does not throw when no socket server is active (e.g. worker process)', async () => {
    getSocketIoMock.mockReturnValueOnce(null)
    const repo = { setOverride: vi.fn().mockResolvedValue({ id: 'row-1' }) }
    const svc = new StoreStatusService(repo)

    await expect(svc.setOverride({ status: 'OPEN', adminId: 'admin-1' })).resolves.toMatchObject({ id: 'row-1' })
    expect(mockIoEmit).not.toHaveBeenCalled()
  })
})

describe('StoreStatusService.checkForAutomaticTransition — the architecture fix (2026-07-04)', () => {
  // Reported bug: the admin sets a weekly schedule (e.g. closes at 9pm),
  // but the store never actually auto-closed anywhere the customer could
  // see, and nothing showed up in activity history proving the schedule
  // was "interconnected" at all — isOpen() was only ever evaluated
  // reactively, per HTTP request. This is the periodic worker's entry
  // point: it must detect a genuine WEEKLY_SCHEDULE (or fail-open DEFAULT)
  // flip and both broadcast it live and log it, while never double-firing
  // for something an admin's own override/hours edit already handled.

  beforeEach(() => {
    mockIoEmit.mockClear()
    mockIoTo.mockClear()
    getSocketIoMock.mockClear()
    emitAuditMock.mockClear()
  })

  function repoWithClaim({ row, claimResult }) {
    return {
      getStatus: vi.fn().mockResolvedValue(row),
      claimStateTransition: vi.fn().mockResolvedValue(claimResult),
    }
  }

  it('broadcasts + logs a system audit entry when the effective state actually flips (positive)', async () => {
    const repo = repoWithClaim({
      row: { manual_override_status: null, weekly_hours: { monday: { open: '09:00', close: '21:00', closed: false } } },
      claimResult: { previousValue: true }, // was open, now closed
    })
    const svc = new StoreStatusService(repo)

    const result = await svc.checkForAutomaticTransition()

    expect(result).not.toBeNull()
    expect(mockIoEmit).toHaveBeenCalledWith('store:status:update', expect.any(Object))
    expect(emitAuditMock).toHaveBeenCalledWith(
      expect.stringMatching(/store_status_auto_(opened|closed)/),
      expect.objectContaining({ target_type: 'store_status', actor_role: 'SYSTEM' })
    )
  })

  it('does nothing when the state has not changed since the last tick (negative)', async () => {
    const repo = repoWithClaim({
      row: { manual_override_status: null, weekly_hours: {} },
      claimResult: null,
    })
    const svc = new StoreStatusService(repo)

    const result = await svc.checkForAutomaticTransition()

    expect(result).toBeNull()
    expect(mockIoEmit).not.toHaveBeenCalled()
    expect(emitAuditMock).not.toHaveBeenCalled()
  })

  it('does nothing on the very first tick after deploy — establishes a baseline instead of reporting a false transition (negative)', async () => {
    const repo = repoWithClaim({
      row: { manual_override_status: null, weekly_hours: {} },
      claimResult: { previousValue: null }, // column was NULL — first run
    })
    const svc = new StoreStatusService(repo)

    const result = await svc.checkForAutomaticTransition()

    expect(result).toBeNull()
    expect(mockIoEmit).not.toHaveBeenCalled()
    expect(emitAuditMock).not.toHaveBeenCalled()
  })
})

describe('StoreStatusService — admin actions sync the baseline so the scheduler never double-fires', () => {
  beforeEach(() => {
    mockIoEmit.mockClear()
    emitAuditMock.mockClear()
  })

  it('setOverride() syncs last-known state after broadcasting', async () => {
    const claimStateTransition = vi.fn().mockResolvedValue(null)
    const repo = {
      setOverride: vi.fn().mockResolvedValue({ id: 'row-1' }),
      getStatus: vi.fn().mockResolvedValue({ manual_override_status: 'CLOSED', weekly_hours: {} }),
      claimStateTransition,
    }
    const svc = new StoreStatusService(repo)

    await svc.setOverride({ status: 'CLOSED', adminId: 'admin-1' })

    expect(claimStateTransition).toHaveBeenCalledWith(false)
    // The admin action's own broadcast already fired — checkForAutomaticTransition
    // was not involved, so no duplicate audit log for this action.
    expect(emitAuditMock).not.toHaveBeenCalled()
  })

  it('updateWeeklyHours() syncs last-known state after broadcasting', async () => {
    const claimStateTransition = vi.fn().mockResolvedValue(null)
    const repo = {
      updateWeeklyHours: vi.fn().mockResolvedValue({ id: 'row-1' }),
      getStatus: vi.fn().mockResolvedValue({ manual_override_status: null, weekly_hours: {} }),
      claimStateTransition,
    }
    const svc = new StoreStatusService(repo)

    await svc.updateWeeklyHours({ monday: { open: '09:00', close: '21:00', closed: false } })

    expect(claimStateTransition).toHaveBeenCalledWith(true) // fail-open default with empty getStatus mock
  })
})
