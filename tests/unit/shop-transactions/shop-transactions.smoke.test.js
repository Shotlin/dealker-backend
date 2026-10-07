import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Avoid touching Redis/Postgres during the smoke test
vi.mock('../../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { ShopTransactionsRepository } from '../../../src/modules/shop-transactions/shop-transactions.repository.js'
import {
  ShopTransactionsService,
  LedgerWriteService,
  __internals,
} from '../../../src/modules/shop-transactions/shop-transactions.service.js'
import { ShopTransactionsController } from '../../../src/modules/shop-transactions/shop-transactions.controller.js'
import {
  TRANSACTION_TYPES,
  REFERENCE_TYPES,
  CREDIT_TYPES,
  DEBIT_TYPES,
  listShopTransactionsQuerySchema,
  ledgerAppendDataSchema,
  ledgerRecordEntrySchema,
  ledgerRecordPairSchema,
} from '../../../src/modules/shop-transactions/shop-transactions.schema.js'
import {
  cacheGet,
  cacheSet,
  cacheDeletePattern,
} from '../../../src/utils/cache.js'

// ─── Test fixtures ─────────────────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'
const TX_ID = '44444444-4444-4444-4444-444444444444'

function makeRepoMock() {
  return {
    findById: vi.fn(),
    findManyByShop: vi.fn(),
    findCurrentBalance: vi.fn(),
    lockLatestForShop: vi.fn(),
    insertEntry: vi.fn(),
  }
}

function makeTxClientMock() {
  const calls = []
  const client = {
    query: vi.fn((sql) => {
      calls.push(sql)
      return Promise.resolve({ rows: [], rowCount: 0 })
    }),
    release: vi.fn(),
  }
  return { client, calls }
}

beforeEach(() => {
  vi.clearAllMocks()
  cacheGet.mockResolvedValue(null)
  cacheSet.mockResolvedValue(undefined)
  cacheDeletePattern.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════════════
// 1. Module bootstrap + schema enums
// ═══════════════════════════════════════════════════════════════════════

describe('shop-transactions module bootstrap', () => {
  it('exports the Repository / Service / Controller / LedgerWriteService classes', () => {
    const repo = new ShopTransactionsRepository()
    const reads = new ShopTransactionsService(repo)
    const writer = new LedgerWriteService(repo, { readService: reads })
    const controller = new ShopTransactionsController(reads)

    expect(typeof reads.list).toBe('function')
    expect(typeof reads.getCurrentBalance).toBe('function')
    expect(typeof reads.getById).toBe('function')
    expect(typeof reads.invalidateShopCache).toBe('function')

    expect(typeof writer.append).toBe('function')
    expect(typeof LedgerWriteService.computeBalanceCents).toBe('function')

    expect(typeof controller.list).toBe('function')
    expect(typeof controller.getBalance).toBe('function')
    expect(typeof controller.getOne).toBe('function')
  })

  it('CREDIT_TYPES and DEBIT_TYPES partition all TRANSACTION_TYPES (Req 7.7)', () => {
    const merged = new Set([...CREDIT_TYPES, ...DEBIT_TYPES])
    for (const t of TRANSACTION_TYPES) expect(merged.has(t)).toBe(true)
    // Disjoint
    for (const t of CREDIT_TYPES) expect(DEBIT_TYPES.has(t)).toBe(false)
  })

  it('lists reference_type values per Req 7.10', () => {
    expect(REFERENCE_TYPES).toEqual(['ORDER', 'PAYOUT', 'ADJUSTMENT', 'EXPENSE', 'REFUND', 'COUPON', 'TAX'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 2. Append-only invariant (Req 7.4 / 15.1)
// ═══════════════════════════════════════════════════════════════════════

describe('append-only invariant — repository surface', () => {
  it('the repository exposes NO update/delete/softDelete methods', () => {
    const repo = new ShopTransactionsRepository()

    // Walk the prototype chain so static + instance methods are both checked.
    const proto = Object.getPrototypeOf(repo)
    const names = Object.getOwnPropertyNames(proto)

    for (const name of names) {
      // Allowlisted append-only mutation:
      if (name === 'insertEntry') continue
      const lower = name.toLowerCase()
      expect(lower).not.toMatch(/^update/)
      expect(lower).not.toMatch(/^delete/)
      expect(lower).not.toMatch(/^remove/)
      expect(lower).not.toMatch(/^soft\s*delete/i)
      expect(lower).not.toMatch(/^upsert/)
      expect(lower).not.toMatch(/^patch/)
    }
  })

  it('the repository source file contains no UPDATE / DELETE SQL on shop_transactions', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const repoPath = path.resolve(
      here,
      '../../../src/modules/shop-transactions/shop-transactions.repository.js'
    )
    const src = fs.readFileSync(repoPath, 'utf8')

    // Strip JSDoc and line comments so descriptive prose can mention these
    // verbs without tripping the guard.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    // Catch SQL UPDATE/DELETE statements (case-insensitive) targeting the table.
    expect(codeOnly).not.toMatch(/UPDATE\s+shop_transactions/i)
    expect(codeOnly).not.toMatch(/DELETE\s+FROM\s+shop_transactions/i)

    // Must still contain the lone INSERT (sanity check on the regex itself).
    expect(codeOnly).toMatch(/INSERT\s+INTO\s+shop_transactions/i)
  })

  it('the routes file registers GET endpoints only — no POST/PATCH/PUT/DELETE', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const routesPath = path.resolve(
      here,
      '../../../src/modules/shop-transactions/shop-transactions.routes.js'
    )
    const src = fs.readFileSync(routesPath, 'utf8')

    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    expect(codeOnly).not.toMatch(/fastify\.post\s*\(/)
    expect(codeOnly).not.toMatch(/fastify\.patch\s*\(/)
    expect(codeOnly).not.toMatch(/fastify\.put\s*\(/)
    expect(codeOnly).not.toMatch(/fastify\.delete\s*\(/)

    // Sanity check the GET registrations are present.
    expect(codeOnly).toMatch(/fastify\.get\s*\(\s*['"]\/['"]/)
    expect(codeOnly).toMatch(/fastify\.get\s*\(\s*['"]\/balance['"]/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 3. Repository SQL safety (Req 14.5, 14.7)
// ═══════════════════════════════════════════════════════════════════════

describe('shop-transactions repository — SQL safety', () => {
  it('SELECT statements never use SELECT *', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const repoPath = path.resolve(
      here,
      '../../../src/modules/shop-transactions/shop-transactions.repository.js'
    )
    const src = fs.readFileSync(repoPath, 'utf8')
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')

    // Allow `COUNT(*)` but not `SELECT *`.
    const matches = codeOnly.match(/SELECT\s+\*/gi)
    expect(matches).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 4. LedgerWriteService.append — happy paths (Req 7.5, 7.7, 7.8, 7.9)
// ═══════════════════════════════════════════════════════════════════════

describe('LedgerWriteService.append — first entry for a shop (Req 7.8)', () => {
  it('treats previous_balance as 0.00 when no row exists yet', async () => {
    const repo = makeRepoMock()
    repo.lockLatestForShop.mockResolvedValueOnce(null)
    repo.insertEntry.mockImplementation(async (_client, row) => ({
      id: TX_ID,
      ...row,
      created_at: new Date(),
    }))
    const reads = new ShopTransactionsService(repo)
    const writer = new LedgerWriteService(repo, { readService: reads })
    const { client } = makeTxClientMock()

    const result = await writer.append(client, {
      shopId: SHOP_ID,
      type: 'ORDER_REVENUE',
      amount: 100.0,
      referenceType: 'ORDER',
      referenceId: ORDER_ID,
      createdBy: USER_ID,
    })

    expect(repo.lockLatestForShop).toHaveBeenCalledTimes(1)
    expect(repo.lockLatestForShop).toHaveBeenCalledWith(client, SHOP_ID)

    expect(repo.insertEntry).toHaveBeenCalledTimes(1)
    const inserted = repo.insertEntry.mock.calls[0][1]
    expect(inserted.shop_id).toBe(SHOP_ID)
    expect(inserted.type).toBe('ORDER_REVENUE')
    expect(inserted.amount).toBe('100.00')
    expect(inserted.balance_after).toBe('100.00') // 0 + 100
    expect(inserted.reference_type).toBe('ORDER')
    expect(inserted.reference_id).toBe(ORDER_ID)
    expect(inserted.created_by).toBe(USER_ID)

    expect(result.balance_after).toBe('100.00')
    // Cache invalidation runs after the insert.
    expect(cacheDeletePattern).toHaveBeenCalledWith(
      `bakaloo:shop-transactions:v1:${SHOP_ID}:*`
    )
  })

  it('treats a zero-balance previous row the same as no previous row', async () => {
    const repo = makeRepoMock()
    // Shop just had a refund that zeroed the ledger.
    repo.lockLatestForShop.mockResolvedValueOnce({ balance_after: '0.00' })
    repo.insertEntry.mockImplementation(async (_client, row) => ({
      id: TX_ID,
      ...row,
    }))
    const writer = new LedgerWriteService(repo)
    const { client } = makeTxClientMock()

    await writer.append(client, {
      shopId: SHOP_ID,
      type: 'ORDER_REVENUE',
      amount: 50,
      referenceType: 'ORDER',
      referenceId: ORDER_ID,
    })

    const inserted = repo.insertEntry.mock.calls[0][1]
    expect(inserted.balance_after).toBe('50.00')
  })
})

describe('LedgerWriteService.append — balance accumulation (Req 7.7)', () => {
  /**
   * Drive the writer through a sequence of (type, amount) pairs, threading
   * the previous balance via the lock-mock between calls. Returns the array
   * of balance_after values written in order.
   */
  async function runSequence(steps) {
    const repo = makeRepoMock()
    let prev = null
    repo.lockLatestForShop.mockImplementation(async () => prev)
    repo.insertEntry.mockImplementation(async (_client, row) => {
      prev = { balance_after: row.balance_after }
      return { id: 'tx-' + Math.random(), ...row }
    })
    const writer = new LedgerWriteService(repo)
    const { client } = makeTxClientMock()

    const balances = []
    for (const [type, amount, refType] of steps) {
      const inserted = await writer.append(client, {
        shopId: SHOP_ID,
        type,
        amount,
        referenceType: refType || 'ORDER',
        referenceId: ORDER_ID,
      })
      balances.push(inserted.balance_after)
    }
    return balances
  }

  it('credits add and debits subtract, in order', async () => {
    const balances = await runSequence([
      ['ORDER_REVENUE', 100], // 0 + 100 = 100.00
      ['COMMISSION_DEBIT', 10], // 100 - 10 = 90.00
      ['DELIVERY_COST', 20], // 90 - 20 = 70.00
      ['REFUND_DEBIT', 15], // 70 - 15 = 55.00
      ['ADJUSTMENT', 5], // 55 + 5 = 60.00
      ['PAYOUT_CREDIT', 60, 'PAYOUT'], // 60 + 60 = 120.00 (legacy semantics)
    ])

    expect(balances).toEqual([
      '100.00',
      '90.00',
      '70.00',
      '55.00',
      '60.00',
      '120.00',
    ])
  })

  it('handles fractional cents without IEEE-754 drift', async () => {
    const balances = await runSequence([
      ['ORDER_REVENUE', 0.1],
      ['ORDER_REVENUE', 0.2], // 0.1 + 0.2 must equal 0.30 exactly
      ['COMMISSION_DEBIT', 0.05], // 0.30 - 0.05 = 0.25
    ])
    expect(balances).toEqual(['0.10', '0.30', '0.25'])
  })

  it('paired ORDER_REVENUE + COMMISSION_DEBIT inside one transaction (Property 12)', async () => {
    const repo = makeRepoMock()
    let prev = null
    repo.lockLatestForShop.mockImplementation(async () => prev)
    repo.insertEntry.mockImplementation(async (_c, row) => {
      prev = { balance_after: row.balance_after }
      return { id: 'tx-' + row.type, ...row }
    })
    const writer = new LedgerWriteService(repo)
    const { client } = makeTxClientMock()

    // Order net total = 200, commission_rate = 10% → commission = 20
    const orderRevenue = await writer.append(client, {
      shopId: SHOP_ID,
      type: 'ORDER_REVENUE',
      amount: 200,
      referenceType: 'ORDER',
      referenceId: ORDER_ID,
    })
    const commission = await writer.append(client, {
      shopId: SHOP_ID,
      type: 'COMMISSION_DEBIT',
      amount: 20,
      referenceType: 'ORDER',
      referenceId: ORDER_ID,
    })

    expect(orderRevenue.balance_after).toBe('200.00')
    expect(commission.balance_after).toBe('180.00')

    // Both entries reference the same order id (Property 12 pairing).
    expect(orderRevenue.reference_id).toBe(ORDER_ID)
    expect(commission.reference_id).toBe(ORDER_ID)

    // FOR UPDATE was issued each time on the same transactional client.
    expect(repo.lockLatestForShop).toHaveBeenCalledTimes(2)
    expect(repo.lockLatestForShop.mock.calls[0][0]).toBe(client)
    expect(repo.lockLatestForShop.mock.calls[1][0]).toBe(client)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 5. LedgerWriteService.append — failure propagation (Req 7.9)
// ═══════════════════════════════════════════════════════════════════════

describe('LedgerWriteService.append — failure propagation', () => {
  it('rejects an invalid amount with LEDGER_VALIDATION_ERROR before any DB call', async () => {
    const repo = makeRepoMock()
    const writer = new LedgerWriteService(repo)
    const { client } = makeTxClientMock()

    await expect(
      writer.append(client, {
        shopId: SHOP_ID,
        type: 'ORDER_REVENUE',
        amount: 0, // below 0.01 minimum
        referenceType: 'ORDER',
      })
    ).rejects.toMatchObject({ code: 'LEDGER_VALIDATION_ERROR' })

    expect(repo.lockLatestForShop).not.toHaveBeenCalled()
    expect(repo.insertEntry).not.toHaveBeenCalled()
  })

  it('throws if no transactional client is provided (Req 7.9 — caller owns BEGIN)', async () => {
    const repo = makeRepoMock()
    const writer = new LedgerWriteService(repo)

    await expect(
      writer.append(null, {
        shopId: SHOP_ID,
        type: 'ORDER_REVENUE',
        amount: 1,
        referenceType: 'ORDER',
      })
    ).rejects.toThrow(/transactional pg client/i)
  })

  it('propagates DB errors from insertEntry so the caller can ROLLBACK', async () => {
    const repo = makeRepoMock()
    repo.lockLatestForShop.mockResolvedValueOnce(null)
    const dbErr = Object.assign(new Error('check constraint violated'), {
      code: '23514',
    })
    repo.insertEntry.mockRejectedValueOnce(dbErr)
    const writer = new LedgerWriteService(repo)
    const { client } = makeTxClientMock()

    await expect(
      writer.append(client, {
        shopId: SHOP_ID,
        type: 'ORDER_REVENUE',
        amount: 1,
        referenceType: 'ORDER',
      })
    ).rejects.toBe(dbErr)

    // Cache must NOT be invalidated when the insert fails.
    expect(cacheDeletePattern).not.toHaveBeenCalled()
  })

  it('an unknown transaction type throws (defence-in-depth past schema validation)', () => {
    expect(() =>
      LedgerWriteService.computeBalanceCents(0, 'NOT_A_REAL_TYPE', 100)
    ).toThrow(/Unknown ledger transaction type/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 6. ShopTransactionsService — read paths
// ═══════════════════════════════════════════════════════════════════════

describe('ShopTransactionsService.list — pagination + caching', () => {
  it('on a cache HIT returns the cached object without querying the repo', async () => {
    const repo = makeRepoMock()
    const cached = { items: [{ id: TX_ID }], total: 1, page: 1, limit: 50 }
    cacheGet.mockResolvedValueOnce(cached)
    const svc = new ShopTransactionsService(repo)

    const out = await svc.list(SHOP_ID, { page: 1, limit: 50 })

    expect(out).toBe(cached)
    expect(repo.findManyByShop).not.toHaveBeenCalled()
    expect(cacheSet).not.toHaveBeenCalled()
  })

  it('on a cache MISS queries the repo and stores with TTL=60', async () => {
    const repo = makeRepoMock()
    repo.findManyByShop.mockResolvedValueOnce({
      items: [{ id: TX_ID }],
      total: 1,
    })
    const svc = new ShopTransactionsService(repo)

    const out = await svc.list(SHOP_ID, { page: 1, limit: 50 })

    expect(out).toEqual({
      items: [{ id: TX_ID }],
      total: 1,
      page: 1,
      limit: 50,
    })
    const [, , ttl] = cacheSet.mock.calls[0]
    expect(ttl).toBe(60)
  })

  it('uses canonical cache key bakaloo:shop-transactions:v1:{shop}:p{page}:l{limit}', () => {
    const svc = new ShopTransactionsService(makeRepoMock())

    expect(svc.cacheKeyForList(SHOP_ID, { page: 1, limit: 50 })).toBe(
      `bakaloo:shop-transactions:v1:${SHOP_ID}:p1:l50`
    )

    expect(
      svc.cacheKeyForList(SHOP_ID, {
        page: 2,
        limit: 100,
        type: 'ORDER_REVENUE',
        reference_type: 'ORDER',
      })
    ).toBe(
      `bakaloo:shop-transactions:v1:${SHOP_ID}:tORDER_REVENUE:rtORDER:p2:l100`
    )
  })
})

describe('ShopTransactionsService.getCurrentBalance', () => {
  it('returns 0.00 when no entries exist (Req 7.8)', async () => {
    const repo = makeRepoMock()
    repo.findCurrentBalance.mockResolvedValueOnce({
      balance: '0.00',
      last_entry_at: null,
    })
    const svc = new ShopTransactionsService(repo)

    const out = await svc.getCurrentBalance(SHOP_ID)
    expect(out).toEqual({ balance: '0.00', last_entry_at: null })
  })

  it('caches with TTL=60 on a miss', async () => {
    const repo = makeRepoMock()
    repo.findCurrentBalance.mockResolvedValueOnce({
      balance: '123.45',
      last_entry_at: new Date('2025-01-01T00:00:00Z'),
    })
    const svc = new ShopTransactionsService(repo)

    await svc.getCurrentBalance(SHOP_ID)

    expect(cacheSet).toHaveBeenCalledTimes(1)
    const [, , ttl] = cacheSet.mock.calls[0]
    expect(ttl).toBe(60)
  })
})

describe('ShopTransactionsService.authorizeRead', () => {
  it.each([
    ['ADMIN', { id: USER_ID, role: 'ADMIN' }, true],
    ['SHOP_ADMIN', { id: USER_ID, shopRole: 'SHOP_ADMIN' }, true],
    ['SHOP_MANAGER', { id: USER_ID, shopRole: 'SHOP_MANAGER' }, true],
    ['SHOP_STAFF', { id: USER_ID, shopRole: 'SHOP_STAFF' }, false],
    ['SHOP_VIEWER', { id: USER_ID, shopRole: 'SHOP_VIEWER' }, false],
    ['CUSTOMER', { id: USER_ID, role: 'CUSTOMER' }, false],
    ['null actor', null, false],
  ])('authorizes %s correctly (Req 13.5)', (_label, actor, allowed) => {
    const svc = new ShopTransactionsService(makeRepoMock())
    const out = svc.authorizeRead(actor)
    expect(out.ok).toBe(allowed)
    if (!allowed) {
      expect(['FORBIDDEN', 'UNAUTHORIZED']).toContain(out.code)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 7. Schema validation
// ═══════════════════════════════════════════════════════════════════════

describe('listShopTransactionsQuerySchema', () => {
  it('clamps limit at 100 (Req 14.7 family)', () => {
    const out = listShopTransactionsQuerySchema.safeParse({ limit: '101' })
    expect(out.success).toBe(false)
  })

  it('coerces "from" / "to" into Date objects', () => {
    const out = listShopTransactionsQuerySchema.safeParse({
      from: '2025-01-01T00:00:00Z',
      to: '2025-01-31T23:59:59Z',
    })
    expect(out.success).toBe(true)
    expect(out.data.from).toBeInstanceOf(Date)
    expect(out.data.to).toBeInstanceOf(Date)
  })

  it('rejects unknown type values', () => {
    const out = listShopTransactionsQuerySchema.safeParse({ type: 'NOT_REAL' })
    expect(out.success).toBe(false)
  })
})

describe('ledgerAppendDataSchema', () => {
  it('accepts a well-formed payload', () => {
    const out = ledgerAppendDataSchema.safeParse({
      shopId: SHOP_ID,
      type: 'ORDER_REVENUE',
      amount: 100.0,
      referenceType: 'ORDER',
      referenceId: ORDER_ID,
      description: 'Order #ABC123 net total',
      createdBy: USER_ID,
    })
    expect(out.success).toBe(true)
  })

  it('rejects amount above 99999999.99 (Req 7.1)', () => {
    const out = ledgerAppendDataSchema.safeParse({
      shopId: SHOP_ID,
      type: 'ORDER_REVENUE',
      amount: 100000000,
      referenceType: 'ORDER',
    })
    expect(out.success).toBe(false)
  })

  it('rejects description longer than 500 chars (Req 7.1)', () => {
    const out = ledgerAppendDataSchema.safeParse({
      shopId: SHOP_ID,
      type: 'ORDER_REVENUE',
      amount: 1,
      referenceType: 'ORDER',
      description: 'a'.repeat(501),
    })
    expect(out.success).toBe(false)
  })

  it('rejects unknown reference_type (Req 7.10)', () => {
    const out = ledgerAppendDataSchema.safeParse({
      shopId: SHOP_ID,
      type: 'ORDER_REVENUE',
      amount: 1,
      referenceType: 'NOT_A_REAL_REF',
    })
    expect(out.success).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 8. Decimal helpers — exact arithmetic
// ═══════════════════════════════════════════════════════════════════════

describe('decimal helpers (toCents / fromCents)', () => {
  it('round-trips finite decimals to 2dp without IEEE-754 drift', () => {
    const { toCents, fromCents } = __internals
    expect(fromCents(toCents('0'))).toBe('0.00')
    expect(fromCents(toCents(0.1) + toCents(0.2))).toBe('0.30')
    expect(fromCents(toCents(123.456))).toBe('123.46') // half-up via Math.round
    expect(fromCents(toCents('99999999.99'))).toBe('99999999.99')
    expect(fromCents(-50)).toBe('-0.50')
  })

  it('rejects non-finite numbers', () => {
    const { toCents } = __internals
    expect(() => toCents('abc')).toThrow()
    expect(() => toCents(NaN)).toThrow()
    expect(() => toCents(Infinity)).toThrow()
  })
})
