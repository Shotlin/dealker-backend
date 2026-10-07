// Feature: multi-vendor-system, task 9.2
// **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 14.6**
//
// Payout_Worker unit tests. The worker is a thin BullMQ dispatcher that
// routes job types (`weekly-run`, `process-payout`, `set-hold`,
// `release-hold`) to the corresponding `PayoutService` entry points and
// exposes a cron registration helper.
//
// Coverage targets (from the task brief):
//   • weekly-run filters PENDING + period_end <= asOfSunday
//   • process-payout PENDING→PROCESSING→PAID happy path with ledger entry
//   • missing bank → HELD (no attempt burn)
//   • transient failure increments attempt_count and goes back to PENDING
//   • third failure → HELD with reason 'max attempts'
//   • set-hold and release-hold transitions
//   • cron registers `0 2 * * 1` UTC with stable jobId
//   • dispatcher logs unknown job types

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Inert collaborator mocks (must come before SUT import) ─────
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/config/bullmq.js', () => ({
  payoutQueue: { add: vi.fn() },
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// `database.js` exports `query` and `getClient`. We replace `getClient`
// with a controllable factory so each test can assert exact SQL the
// service issued through the transactional client.
const dbState = {
  clients: [],
}
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn().mockImplementation(async () => {
    const client = makeFakeClient()
    dbState.clients.push(client)
    return client
  }),
}))

import {
  createPayoutProcessor,
  schedulePayoutCron,
} from '../../../src/workers/payout.worker.js'
import {
  PayoutService,
  precedingSundayDateString,
} from '../../../src/modules/shop-financials/payout.service.js'
import { logger } from '../../../src/config/logger.js'

// ─── Fixtures ───────────────────────────────────────────────────
const SHOP_A = '11111111-1111-1111-1111-111111111111'
const FIN_A = '22222222-2222-2222-2222-222222222222'

const validBank = {
  bank_account_number: '1234567890',
  bank_ifsc: 'HDFC0001234',
  bank_name: 'HDFC',
  bank_holder_name: 'Bakaloo Mart',
}

const lockedRow = (overrides = {}) => ({
  id: FIN_A,
  shop_id: SHOP_A,
  period_type: 'WEEKLY',
  period_start: '2024-03-11',
  period_end: '2024-03-17',
  gross_revenue: '1000.00',
  net_revenue: '850.00',
  total_orders: 5,
  avg_order_value: '200.00',
  platform_commission: '100.00',
  delivery_costs: '50.00',
  refund_amount: '0.00',
  payout_amount: '850.00',
  payout_status: 'PENDING',
  payout_ref: null,
  paid_at: null,
  failure_reason: null,
  attempt_count: 0,
  ...overrides,
})

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Build a fake pg client that records every BEGIN/COMMIT/ROLLBACK and
 * silently no-ops other queries. The service's repository methods are
 * mocked separately, so the only SQL hitting this fake is the
 * BEGIN/COMMIT/ROLLBACK pair owned directly by `payout.service.js`.
 */
function makeFakeClient() {
  const calls = []
  return {
    calls,
    released: false,
    query: vi.fn(async (text) => {
      const sql = typeof text === 'string' ? text : text?.text || ''
      calls.push({ sql })
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(function () {
      this.released = true
    }),
  }
}

function makeQueueMock() {
  return { add: vi.fn().mockResolvedValue(undefined) }
}

function makeJob({ id = 'job-1', name, data }) {
  return { id, name, data }
}

beforeEach(() => {
  vi.clearAllMocks()
  dbState.clients = []
})

// ═══════════════════════════════════════════════════════════════
// precedingSundayDateString — the period-end cutoff for Req 8.1
// ═══════════════════════════════════════════════════════════════

describe('precedingSundayDateString (Req 8.1)', () => {
  it('Monday 02:00 UTC → previous Sunday', () => {
    // 2024-03-18 is a Monday; the preceding Sunday is 2024-03-17.
    expect(
      precedingSundayDateString(new Date('2024-03-18T02:00:00.000Z'))
    ).toBe('2024-03-17')
  })

  it('mid-week → most recent past Sunday', () => {
    // 2024-03-20 is a Wednesday; previous Sunday is still 2024-03-17.
    expect(
      precedingSundayDateString(new Date('2024-03-20T12:00:00.000Z'))
    ).toBe('2024-03-17')
  })

  it('Sunday → the Sunday BEFORE today (full closed week)', () => {
    // 2024-03-17 is a Sunday; the closed week ends 2024-03-10.
    expect(
      precedingSundayDateString(new Date('2024-03-17T01:00:00.000Z'))
    ).toBe('2024-03-10')
  })

  it('Saturday → most recent past Sunday', () => {
    // 2024-03-23 is a Saturday → preceding Sunday is 2024-03-17.
    expect(
      precedingSundayDateString(new Date('2024-03-23T23:30:00.000Z'))
    ).toBe('2024-03-17')
  })
})

// ═══════════════════════════════════════════════════════════════
// weekly-run — Req 8.1
// ═══════════════════════════════════════════════════════════════

describe('createPayoutProcessor — weekly-run (Req 8.1)', () => {
  it('enqueues one process-payout job per PENDING row with deterministic jobId', async () => {
    const queue = makeQueueMock()
    const writeRepository = {
      findPendingPayouts: vi
        .fn()
        // first page returns 2 rows, second page returns empty
        .mockResolvedValueOnce([
          { id: 'fin-1', shop_id: SHOP_A, payout_amount: '100.00' },
          { id: 'fin-2', shop_id: SHOP_A, payout_amount: '200.00' },
        ])
        .mockResolvedValueOnce([]),
    }
    const service = new PayoutService({
      writeRepository,
      queue,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'weekly-run',
        data: { type: 'weekly-run', asOf: '2024-03-18T02:00:00.000Z' },
      })
    )

    expect(result.type).toBe('weekly-run')
    expect(result.enqueued).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.asOfDate).toBe('2024-03-17')

    expect(writeRepository.findPendingPayouts).toHaveBeenCalledWith(
      expect.objectContaining({ asOfDate: '2024-03-17', limit: 50 })
    )

    expect(queue.add).toHaveBeenCalledTimes(2)
    expect(queue.add.mock.calls[0][0]).toBe('process-payout')
    expect(queue.add.mock.calls[0][1]).toMatchObject({
      type: 'process-payout',
      financialId: 'fin-1',
    })
    expect(queue.add.mock.calls[0][2]).toMatchObject({
      jobId: 'process-payout:fin-1',
    })
    expect(queue.add.mock.calls[1][2]).toMatchObject({
      jobId: 'process-payout:fin-2',
    })
  })

  it('keyset pagination: walks pages until empty', async () => {
    const queue = makeQueueMock()
    const writeRepository = {
      findPendingPayouts: vi
        .fn()
        .mockImplementation(async ({ afterId }) => {
          if (!afterId) {
            return Array.from({ length: 50 }, (_, i) => ({
              id: `fin-a-${i}`,
              shop_id: SHOP_A,
            }))
          }
          if (afterId === 'fin-a-49') {
            return [{ id: 'fin-b-0', shop_id: SHOP_A }]
          }
          return []
        }),
    }
    const service = new PayoutService({
      writeRepository,
      queue,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'weekly-run',
        data: { type: 'weekly-run', asOf: '2024-03-18T02:00:00.000Z' },
      })
    )

    expect(result.enqueued).toBe(51)
    expect(writeRepository.findPendingPayouts).toHaveBeenCalledTimes(2)
  })

  it('logs a warning and counts a skip when queue.add rejects', async () => {
    const queue = {
      add: vi
        .fn()
        .mockRejectedValueOnce(new Error('queue down'))
        .mockResolvedValueOnce(undefined),
    }
    const writeRepository = {
      findPendingPayouts: vi
        .fn()
        .mockResolvedValueOnce([
          { id: 'fin-1', shop_id: SHOP_A },
          { id: 'fin-2', shop_id: SHOP_A },
        ])
        .mockResolvedValueOnce([]),
    }
    const service = new PayoutService({
      writeRepository,
      queue,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({ name: 'weekly-run', data: { type: 'weekly-run' } })
    )

    expect(result.enqueued).toBe(1)
    expect(result.skipped).toBe(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payout_enqueue_failed' }),
      expect.any(String)
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// process-payout — happy path (Req 8.2, 8.3)
// ═══════════════════════════════════════════════════════════════

describe('createPayoutProcessor — process-payout happy path (Req 8.2, 8.3)', () => {
  it('PENDING → PROCESSING → PAID and writes a PAYOUT_CREDIT ledger entry', async () => {
    const writeRepository = {
      lockFinancialById: vi.fn().mockResolvedValueOnce(lockedRow()),
      findShopBankDetails: vi.fn().mockResolvedValueOnce(validBank),
      transitionPayoutStatus: vi
        .fn()
        // PENDING → PROCESSING
        .mockResolvedValueOnce(lockedRow({ payout_status: 'PROCESSING' }))
        // PROCESSING → PAID
        .mockResolvedValueOnce(
          lockedRow({
            payout_status: 'PAID',
            paid_at: new Date(),
            payout_ref: 'INTERNAL-test',
          })
        ),
    }
    const ledger = { recordEntry: vi.fn().mockResolvedValue({}) }
    const queue = makeQueueMock()
    const service = new PayoutService({
      writeRepository,
      queue,
      ledgerWriteService: ledger,
      financialsService: { invalidateForShop: vi.fn() },
      disburse: vi.fn().mockResolvedValue({ payoutRef: 'INTERNAL-test' }),
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'process-payout',
        data: { type: 'process-payout', financialId: FIN_A },
      })
    )

    expect(result.outcome).toBe('PAID')
    expect(result.payoutStatus).toBe('PAID')
    expect(result.payoutRef).toBe('INTERNAL-test')

    // Two transitions in order: PENDING→PROCESSING then PROCESSING→PAID
    expect(writeRepository.transitionPayoutStatus).toHaveBeenCalledTimes(2)
    expect(writeRepository.transitionPayoutStatus.mock.calls[0]).toEqual([
      expect.anything(),
      FIN_A,
      ['PENDING'],
      'PROCESSING',
      expect.objectContaining({ clearFailureReason: true }),
    ])
    expect(writeRepository.transitionPayoutStatus.mock.calls[1]).toEqual([
      expect.anything(),
      FIN_A,
      ['PROCESSING'],
      'PAID',
      expect.objectContaining({ payoutRef: 'INTERNAL-test' }),
    ])

    // Ledger entry written for PAYOUT_CREDIT, in the same client (Req 8.3)
    expect(ledger.recordEntry).toHaveBeenCalledTimes(1)
    expect(ledger.recordEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        shop_id: SHOP_A,
        type: 'PAYOUT_CREDIT',
        amount: 850,
        reference_type: 'PAYOUT',
        reference_id: FIN_A,
      })
    )

    // Transactional contract: BEGIN + COMMIT, no ROLLBACK
    const c = dbState.clients[0]
    expect(c.calls.find((q) => /^\s*BEGIN/i.test(q.sql))).toBeDefined()
    expect(c.calls.find((q) => /^\s*COMMIT/i.test(q.sql))).toBeDefined()
    expect(c.calls.find((q) => /^\s*ROLLBACK/i.test(q.sql))).toBeUndefined()
    expect(c.released).toBe(true)
  })

  it('NOT_FOUND when the row does not exist (no transitions, ROLLBACK)', async () => {
    const writeRepository = {
      lockFinancialById: vi.fn().mockResolvedValueOnce(null),
      findShopBankDetails: vi.fn(),
      transitionPayoutStatus: vi.fn(),
    }
    const ledger = { recordEntry: vi.fn() }
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: ledger,
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'process-payout',
        data: { type: 'process-payout', financialId: FIN_A },
      })
    )

    expect(result.outcome).toBe('NOT_FOUND')
    expect(writeRepository.transitionPayoutStatus).not.toHaveBeenCalled()
    expect(ledger.recordEntry).not.toHaveBeenCalled()
  })

  it('skipped when financialId is missing', async () => {
    const service = new PayoutService({
      writeRepository: { findPendingPayouts: vi.fn() },
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({ name: 'process-payout', data: { type: 'process-payout' } })
    )

    expect(result).toEqual({ type: 'process-payout', skipped: true })
  })
})

// ═══════════════════════════════════════════════════════════════
// process-payout — missing bank details (Req 8.6)
// ═══════════════════════════════════════════════════════════════

describe('createPayoutProcessor — missing bank details (Req 8.6)', () => {
  it('routes to HELD with reason "missing bank details" and never burns an attempt', async () => {
    const writeRepository = {
      lockFinancialById: vi.fn().mockResolvedValueOnce(lockedRow()),
      findShopBankDetails: vi
        .fn()
        // any null/empty value triggers the HELD branch
        .mockResolvedValueOnce({ ...validBank, bank_ifsc: '' }),
      transitionPayoutStatus: vi
        .fn()
        .mockResolvedValueOnce(lockedRow({ payout_status: 'HELD' })),
      incrementAttemptCount: vi.fn(),
    }
    const ledger = { recordEntry: vi.fn() }
    const disburse = vi.fn()
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: ledger,
      financialsService: { invalidateForShop: vi.fn() },
      disburse,
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'process-payout',
        data: { type: 'process-payout', financialId: FIN_A },
      })
    )

    expect(result.outcome).toBe('HELD_MISSING_BANK')
    expect(result.payoutStatus).toBe('HELD')
    expect(result.reason).toBe('missing bank details')

    // Exactly one transition (PENDING/PROCESSING → HELD)
    expect(writeRepository.transitionPayoutStatus).toHaveBeenCalledTimes(1)
    expect(writeRepository.transitionPayoutStatus).toHaveBeenCalledWith(
      expect.anything(),
      FIN_A,
      ['PENDING', 'PROCESSING'],
      'HELD',
      expect.objectContaining({ failureReason: 'missing bank details' })
    )

    // No attempt burn (Req 8.6)
    expect(writeRepository.incrementAttemptCount).not.toHaveBeenCalled()
    // No disbursement / ledger entry
    expect(disburse).not.toHaveBeenCalled()
    expect(ledger.recordEntry).not.toHaveBeenCalled()
  })

  it('treats an entirely-null bank record as missing details', async () => {
    const writeRepository = {
      lockFinancialById: vi.fn().mockResolvedValueOnce(lockedRow()),
      findShopBankDetails: vi.fn().mockResolvedValueOnce(null),
      transitionPayoutStatus: vi
        .fn()
        .mockResolvedValueOnce(lockedRow({ payout_status: 'HELD' })),
      incrementAttemptCount: vi.fn(),
    }
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
      disburse: vi.fn(),
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'process-payout',
        data: { type: 'process-payout', financialId: FIN_A },
      })
    )

    expect(result.outcome).toBe('HELD_MISSING_BANK')
  })
})

// ═══════════════════════════════════════════════════════════════
// process-payout — transient failure / max attempts (Req 8.5)
// ═══════════════════════════════════════════════════════════════

describe('createPayoutProcessor — disbursement failure (Req 8.5)', () => {
  it('1st failure: increments attempt_count and goes back to PENDING', async () => {
    const writeRepository = {
      lockFinancialById: vi
        .fn()
        // First call: initial lock (attempt_count = 0)
        .mockResolvedValueOnce(lockedRow({ attempt_count: 0 }))
        // Second call: re-lock inside _handleDisbursementFailure
        .mockResolvedValueOnce(lockedRow({ attempt_count: 0 })),
      findShopBankDetails: vi.fn().mockResolvedValueOnce(validBank),
      transitionPayoutStatus: vi
        .fn()
        // PENDING → PROCESSING
        .mockResolvedValueOnce(lockedRow({ payout_status: 'PROCESSING' }))
        // PROCESSING → PENDING (retry)
        .mockResolvedValueOnce(
          lockedRow({ payout_status: 'PENDING', attempt_count: 1 })
        ),
      incrementAttemptCount: vi.fn().mockResolvedValueOnce(1),
    }
    const ledger = { recordEntry: vi.fn() }
    const disburse = vi
      .fn()
      .mockRejectedValueOnce(new Error('bank API timeout'))
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: ledger,
      financialsService: { invalidateForShop: vi.fn() },
      disburse,
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'process-payout',
        data: { type: 'process-payout', financialId: FIN_A },
      })
    )

    expect(result.outcome).toBe('RETRY_PENDING')
    expect(result.payoutStatus).toBe('PENDING')
    expect(result.attemptCount).toBe(1)
    expect(result.reason).toBe('bank API timeout')

    // Two transitions: PENDING→PROCESSING (initial), then PROCESSING→PENDING (retry)
    expect(writeRepository.transitionPayoutStatus).toHaveBeenCalledTimes(2)
    expect(
      writeRepository.transitionPayoutStatus.mock.calls[1][3]
    ).toBe('PENDING')
    expect(writeRepository.incrementAttemptCount).toHaveBeenCalledTimes(1)
    // No PAID transition, no ledger
    expect(ledger.recordEntry).not.toHaveBeenCalled()
  })

  it('3rd failure (attempt_count reaches 3): flips to HELD with reason "max attempts"', async () => {
    const writeRepository = {
      lockFinancialById: vi
        .fn()
        // Initial lock (already had 2 prior failures, attempt_count = 2)
        .mockResolvedValueOnce(lockedRow({ attempt_count: 2 }))
        // Re-lock inside failure handler
        .mockResolvedValueOnce(lockedRow({ attempt_count: 2 })),
      findShopBankDetails: vi.fn().mockResolvedValueOnce(validBank),
      transitionPayoutStatus: vi
        .fn()
        // PENDING → PROCESSING
        .mockResolvedValueOnce(lockedRow({ payout_status: 'PROCESSING' }))
        // PROCESSING → HELD (max attempts)
        .mockResolvedValueOnce(
          lockedRow({ payout_status: 'HELD', attempt_count: 3 })
        ),
      incrementAttemptCount: vi.fn().mockResolvedValueOnce(3),
    }
    const ledger = { recordEntry: vi.fn() }
    const disburse = vi
      .fn()
      .mockRejectedValueOnce(new Error('bank rejected'))
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: ledger,
      financialsService: { invalidateForShop: vi.fn() },
      disburse,
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'process-payout',
        data: { type: 'process-payout', financialId: FIN_A },
      })
    )

    expect(result.outcome).toBe('HELD_MAX_ATTEMPTS')
    expect(result.payoutStatus).toBe('HELD')
    expect(result.attemptCount).toBe(3)

    expect(writeRepository.transitionPayoutStatus).toHaveBeenCalledTimes(2)
    const heldCall = writeRepository.transitionPayoutStatus.mock.calls[1]
    expect(heldCall[3]).toBe('HELD')
    expect(heldCall[4]?.failureReason).toMatch(/max attempts/)

    expect(ledger.recordEntry).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════
// set-hold / release-hold (Req 8.7)
// ═══════════════════════════════════════════════════════════════

describe('createPayoutProcessor — admin hold/release (Req 8.7)', () => {
  it('set-hold: PENDING → HELD via guarded transition', async () => {
    const writeRepository = {
      lockFinancialById: vi.fn().mockResolvedValueOnce(lockedRow()),
      transitionPayoutStatus: vi
        .fn()
        .mockResolvedValueOnce(lockedRow({ payout_status: 'HELD' })),
    }
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'set-hold',
        data: {
          type: 'set-hold',
          financialId: FIN_A,
          actorId: 'admin-uuid',
        },
      })
    )

    expect(result.ok).toBe(true)
    expect(result.row.payout_status).toBe('HELD')
    expect(writeRepository.transitionPayoutStatus).toHaveBeenCalledWith(
      expect.anything(),
      FIN_A,
      ['PENDING', 'PROCESSING'],
      'HELD',
      expect.any(Object)
    )
  })

  it('set-hold: PAID row is rejected with PAYOUT_INVALID_STATE (guard fails)', async () => {
    const writeRepository = {
      lockFinancialById: vi
        .fn()
        .mockResolvedValueOnce(lockedRow({ payout_status: 'PAID' })),
      transitionPayoutStatus: vi.fn().mockResolvedValueOnce(null),
    }
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'set-hold',
        data: { type: 'set-hold', financialId: FIN_A },
      })
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('PAYOUT_INVALID_STATE')
  })

  it('release-hold: HELD → PENDING and clears failure_reason', async () => {
    const writeRepository = {
      lockFinancialById: vi
        .fn()
        .mockResolvedValueOnce(lockedRow({ payout_status: 'HELD' })),
      transitionPayoutStatus: vi
        .fn()
        .mockResolvedValueOnce(lockedRow({ payout_status: 'PENDING' })),
    }
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'release-hold',
        data: { type: 'release-hold', financialId: FIN_A },
      })
    )

    expect(result.ok).toBe(true)
    expect(result.row.payout_status).toBe('PENDING')
    expect(writeRepository.transitionPayoutStatus).toHaveBeenCalledWith(
      expect.anything(),
      FIN_A,
      ['HELD'],
      'PENDING',
      expect.objectContaining({ clearFailureReason: true })
    )
  })

  it('release-hold: returns NOT_FOUND when row missing', async () => {
    const writeRepository = {
      lockFinancialById: vi.fn().mockResolvedValueOnce(null),
      transitionPayoutStatus: vi.fn(),
    }
    const service = new PayoutService({
      writeRepository,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({
        name: 'release-hold',
        data: { type: 'release-hold', financialId: FIN_A },
      })
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe('SHOP_FINANCIAL_NOT_FOUND')
    expect(writeRepository.transitionPayoutStatus).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════════
// Unknown job type & cron registration
// ═══════════════════════════════════════════════════════════════

describe('createPayoutProcessor — dispatcher edge cases', () => {
  it('logs a structured warning and returns ignored: true on unknown job type', async () => {
    const service = new PayoutService({
      writeRepository: { findPendingPayouts: vi.fn() },
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    const result = await process(
      makeJob({ name: 'mystery', data: { type: 'mystery' } })
    )

    expect(result).toEqual({ ignored: true })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payout_unknown_job_type' }),
      expect.any(String)
    )
  })

  it('routes by job.data.type when present, falling back to job.name', async () => {
    const writeRepository = {
      findPendingPayouts: vi.fn().mockResolvedValueOnce([]),
    }
    const queue = makeQueueMock()
    const service = new PayoutService({
      writeRepository,
      queue,
      ledgerWriteService: { recordEntry: vi.fn() },
      financialsService: { invalidateForShop: vi.fn() },
    })
    const process = createPayoutProcessor({ payoutService: service })

    await process(
      makeJob({
        name: 'mystery',
        data: { type: 'weekly-run' },
      })
    )

    expect(writeRepository.findPendingPayouts).toHaveBeenCalled()
  })
})

describe('schedulePayoutCron (Req 8.1, 14.6)', () => {
  it('registers a Mon 02:00 UTC repeatable job with a stable jobId', async () => {
    const queue = makeQueueMock()
    await schedulePayoutCron(queue)
    expect(queue.add).toHaveBeenCalledWith(
      'weekly-run',
      { type: 'weekly-run' },
      expect.objectContaining({
        repeat: { pattern: '0 2 * * 1', tz: 'UTC' },
        jobId: 'payout-weekly-cron',
      })
    )
  })

  it('is a no-op when the queue is missing', async () => {
    await expect(schedulePayoutCron(null)).resolves.toBeUndefined()
    await expect(schedulePayoutCron(undefined)).resolves.toBeUndefined()
  })
})
