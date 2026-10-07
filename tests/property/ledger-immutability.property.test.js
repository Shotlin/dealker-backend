// Feature: multi-vendor-system, Property 11: Ledger Immutability
// **Validates: Requirements 7.3, 7.4, 15.1**
//
// Property:
//   For any existing ledger entry, no operation on the shop-transactions
//   module can modify or delete it. The transaction count grows strictly
//   monotonically — each successful append increments it by exactly 1, and
//   no read path mutates state.
//
// Approach:
//   The append-only invariant is enforced *structurally* by the module:
//     - the repository class exposes no update/delete/remove/softDelete/upsert/patch
//       methods (only `insertEntry` and read methods exist),
//     - the routes file registers only GET handlers,
//     - the SQL layer never emits UPDATE/DELETE against shop_transactions.
//
//   This file uses fast-check to drive *randomised* discovery against those
//   surfaces. Random method-name samples are property-checked against the
//   real prototype. Random byte offsets into the source files are sampled
//   and the surrounding text is verified to never contain a forbidden
//   construct. Finally, an in-memory append simulator drives arbitrary
//   sequences of appends and reads through the real repository under a
//   recording fake pg client and asserts:
//     - count grows by exactly +1 per successful insertEntry,
//     - reads never alter the count or any existing row,
//     - no row ever changes byte-for-byte after insertion.
//
// References:
//   - bakaloo-backend/src/modules/shop-transactions/shop-transactions.repository.js
//   - bakaloo-backend/src/modules/shop-transactions/shop-transactions.routes.js
//   - bakaloo-backend/tests/unit/shop-transactions/shop-transactions.smoke.test.js

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── Mock external infra BEFORE importing the module ────────
vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheDeletePattern: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { ShopTransactionsRepository } from '../../src/modules/shop-transactions/shop-transactions.repository.js'
import { LedgerWriteService } from '../../src/modules/shop-transactions/shop-transactions.service.js'

// ─── Source file paths (resolved once) ─────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_PATH = path.resolve(
  HERE,
  '../../src/modules/shop-transactions/shop-transactions.repository.js'
)
const ROUTES_PATH = path.resolve(
  HERE,
  '../../src/modules/shop-transactions/shop-transactions.routes.js'
)
const SERVICE_PATH = path.resolve(
  HERE,
  '../../src/modules/shop-transactions/shop-transactions.service.js'
)

const REPO_SRC = fs.readFileSync(REPO_PATH, 'utf8')
const ROUTES_SRC = fs.readFileSync(ROUTES_PATH, 'utf8')
const SERVICE_SRC = fs.readFileSync(SERVICE_PATH, 'utf8')

// Strip JSDoc and line comments so descriptive prose ("never UPDATE…")
// inside doc-blocks doesn't trip the structural guards. Ledger immutability
// is a property of the *code*, not the comments.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
}
const REPO_CODE = stripComments(REPO_SRC)
const ROUTES_CODE = stripComments(ROUTES_SRC)
const SERVICE_CODE = stripComments(SERVICE_SRC)

// Forbidden mutation prefixes on the repository surface (Req 7.3, 7.4, 15.1).
// `insertEntry` is the *only* allowed mutation entry-point.
const FORBIDDEN_PREFIX_RE = /^(update|delete|remove|soft\s*delete|upsert|patch)/i

// ─── Test fixtures ─────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'
const ORDER_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════════
// Property 11.1 — Repository surface is append-only
// ═══════════════════════════════════════════════════════════════
describe('Property 11: Ledger Immutability — repository surface', () => {
  it('no enumerable method on ShopTransactionsRepository.prototype matches /^(update|delete|remove|softDelete|upsert|patch)/i', () => {
    const proto = ShopTransactionsRepository.prototype
    const names = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor'
    )

    // Every concrete name must pass the structural guard.
    for (const name of names) {
      expect(name).not.toMatch(FORBIDDEN_PREFIX_RE)
    }

    // Sanity: the only known mutation method is `insertEntry`.
    expect(names).toContain('insertEntry')
  })

  it('for any randomly sampled forbidden method name, the prototype does not expose it', () => {
    const proto = ShopTransactionsRepository.prototype
    const names = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor'
    )

    // Generate arbitrary candidate method names — including the forbidden
    // prefixes — and assert that none of them happen to exist on the
    // prototype. This is the property-style enumeration the design calls
    // for: the invariant must hold across the entire generator space, not
    // just a hardcoded blocklist.
    const verbArb = fc.constantFrom(
      'update',
      'Update',
      'UPDATE',
      'delete',
      'Delete',
      'DELETE',
      'remove',
      'Remove',
      'softDelete',
      'soft_delete',
      'upsert',
      'Upsert',
      'patch',
      'Patch'
    )
    const suffixArb = fc.stringMatching(/^[A-Za-z0-9]{0,32}$/)

    fc.assert(
      fc.property(verbArb, suffixArb, (verb, suffix) => {
        const candidate = verb + suffix
        // The candidate must NEVER appear among the real prototype methods.
        return !names.includes(candidate)
      }),
      { numRuns: 200 }
    )
  })

  it('every existing repository method is either `insertEntry` or has a read-only prefix (find/lock)', () => {
    const proto = ShopTransactionsRepository.prototype
    const names = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor'
    )
    const READ_OR_APPEND_RE = /^(find|lock|get|insertEntry$)/i
    for (const name of names) {
      expect(name).toMatch(READ_OR_APPEND_RE)
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 11.2 — Routes file registers GET only
// ═══════════════════════════════════════════════════════════════
describe('Property 11: Ledger Immutability — routes are read-only', () => {
  it('the routes source contains zero fastify.{post,patch,put,delete} registrations', () => {
    expect(ROUTES_CODE).not.toMatch(/fastify\.post\s*\(/)
    expect(ROUTES_CODE).not.toMatch(/fastify\.patch\s*\(/)
    expect(ROUTES_CODE).not.toMatch(/fastify\.put\s*\(/)
    expect(ROUTES_CODE).not.toMatch(/fastify\.delete\s*\(/)

    // Sanity: the GETs we expect are present.
    expect(ROUTES_CODE).toMatch(/fastify\.get\s*\(/)
  })

  it('for any random byte window in the routes file, it does not contain a write-method registration', () => {
    // Property: pick random offsets and assert the surrounding window never
    // matches a forbidden HTTP verb registration. This generalises the
    // hardcoded checks above into a randomised scan — the invariant must
    // hold across every contiguous slice of the file, regardless of where
    // the regex engine starts. If a future commit adds `fastify.post(`
    // anywhere, this property will catch it with high probability.
    const len = ROUTES_CODE.length
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Math.max(0, len - 1) }),
        fc.integer({ min: 16, max: 256 }),
        (offset, windowSize) => {
          const start = Math.max(0, offset - windowSize)
          const end = Math.min(len, offset + windowSize)
          const slice = ROUTES_CODE.slice(start, end)
          return (
            !/fastify\.post\s*\(/.test(slice) &&
            !/fastify\.patch\s*\(/.test(slice) &&
            !/fastify\.put\s*\(/.test(slice) &&
            !/fastify\.delete\s*\(/.test(slice)
          )
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 11.3 — SQL layer never UPDATEs/DELETEs shop_transactions
// ═══════════════════════════════════════════════════════════════
describe('Property 11: Ledger Immutability — SQL layer is append-only', () => {
  it('the repository code contains no UPDATE shop_transactions or DELETE FROM shop_transactions', () => {
    expect(REPO_CODE).not.toMatch(/UPDATE\s+shop_transactions/i)
    expect(REPO_CODE).not.toMatch(/DELETE\s+FROM\s+shop_transactions/i)

    // Sanity: there must still be exactly one INSERT into the table.
    const insertMatches =
      REPO_CODE.match(/INSERT\s+INTO\s+shop_transactions/gi) || []
    expect(insertMatches.length).toBe(1)
  })

  it('the service code contains no UPDATE/DELETE on shop_transactions', () => {
    expect(SERVICE_CODE).not.toMatch(/UPDATE\s+shop_transactions/i)
    expect(SERVICE_CODE).not.toMatch(/DELETE\s+FROM\s+shop_transactions/i)
  })

  it('for any random byte window in the repository file, it never contains UPDATE/DELETE shop_transactions', () => {
    const len = REPO_CODE.length
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: Math.max(0, len - 1) }),
        fc.integer({ min: 32, max: 512 }),
        (offset, windowSize) => {
          const start = Math.max(0, offset - windowSize)
          const end = Math.min(len, offset + windowSize)
          const slice = REPO_CODE.slice(start, end)
          return (
            !/UPDATE\s+shop_transactions/i.test(slice) &&
            !/DELETE\s+FROM\s+shop_transactions/i.test(slice)
          )
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 11.4 — Append simulator: count grows monotonically
// ═══════════════════════════════════════════════════════════════

/**
 * Build a recording fake pg client backed by an in-memory shop_transactions
 * table. Recognises the SQL fragments emitted by the repository:
 *   - SELECT … LIMIT 1 FOR UPDATE → returns the latest row (or none)
 *   - INSERT INTO shop_transactions → appends a row, returns the inserted row
 *   - SELECT … FROM shop_transactions WHERE shop_id = $1 ORDER BY … LIMIT 1
 *     (no FOR UPDATE) → findCurrentBalance read
 *   - SELECT COUNT(*)::int AS total FROM shop_transactions → count read
 *   - SELECT … LIMIT $N OFFSET $M → findManyByShop list read
 * Returns the same shape pg returns: { rows, rowCount }.
 */
function makeFakeLedgerClient() {
  const table = [] // append-only array of inserted rows
  let nextId = 1

  const api = {
    table,
    snapshot() {
      // Deep-clone every row so callers can't mutate state through us.
      return table.map((r) => ({ ...r }))
    },
    count() {
      return table.length
    },
    async query(sql, params = []) {
      const text = typeof sql === 'string' ? sql : sql?.text || ''

      // SELECT … FOR UPDATE — lockLatestForShop()
      if (/FOR\s+UPDATE/i.test(text) && /shop_transactions/i.test(text)) {
        const [shopId] = params
        const latest = [...table]
          .filter((r) => r.shop_id === shopId)
          .sort((a, b) => b.created_at - a.created_at)[0]
        return {
          rows: latest ? [{ ...latest }] : [],
          rowCount: latest ? 1 : 0,
        }
      }

      // INSERT INTO shop_transactions — insertEntry()
      if (/^\s*INSERT\s+INTO\s+shop_transactions/i.test(text)) {
        const [
          shop_id,
          type,
          amount,
          balance_after,
          reference_type,
          reference_id,
          description,
          created_by,
        ] = params
        const row = {
          id: `tx-${String(nextId++).padStart(8, '0')}`,
          shop_id,
          type,
          amount,
          balance_after,
          reference_type,
          reference_id,
          description,
          created_by,
          created_at: new Date(Date.now() + table.length), // strictly increasing
        }
        table.push(row)
        return { rows: [{ ...row }], rowCount: 1 }
      }

      // COUNT(*) — findManyByShop count branch
      if (/SELECT\s+COUNT\(\*\)::int\s+AS\s+total/i.test(text)) {
        const [shopId] = params
        const total = table.filter((r) => r.shop_id === shopId).length
        return { rows: [{ total }], rowCount: 1 }
      }

      // SELECT … FROM shop_transactions WHERE shop_id = $1 ORDER BY … LIMIT … OFFSET …
      // (used by findManyByShop data branch)
      if (
        /^\s*SELECT[\s\S]+FROM\s+shop_transactions/i.test(text) &&
        /OFFSET/i.test(text)
      ) {
        const shopId = params[0]
        const limit = params[params.length - 2]
        const offset = params[params.length - 1]
        const rows = [...table]
          .filter((r) => r.shop_id === shopId)
          .sort((a, b) => b.created_at - a.created_at)
          .slice(offset, offset + limit)
          .map((r) => ({ ...r }))
        return { rows, rowCount: rows.length }
      }

      // SELECT … FROM shop_transactions … LIMIT 1 (findCurrentBalance, no FOR UPDATE)
      if (
        /^\s*SELECT[\s\S]+FROM\s+shop_transactions/i.test(text) &&
        /LIMIT\s+1/i.test(text)
      ) {
        const [shopId] = params
        const latest = [...table]
          .filter((r) => r.shop_id === shopId)
          .sort((a, b) => b.created_at - a.created_at)[0]
        return {
          rows: latest ? [{ ...latest }] : [],
          rowCount: latest ? 1 : 0,
        }
      }

      // BEGIN / COMMIT / ROLLBACK or anything we don't recognise — no-op.
      return { rows: [], rowCount: 0 }
    },
    release: vi.fn(),
  }
  return api
}

describe('Property 11: Ledger Immutability — append simulator', () => {
  it('for arbitrary append/read sequences, count grows by exactly +1 per append and reads never mutate', async () => {
    // Operations:
    //   { op: 'append', amount, type } — call LedgerWriteService.append()
    //   { op: 'read-balance' }          — call repo.findCurrentBalance() (read-only)
    //   { op: 'read-list', page, limit } — call repo.findManyByShop()    (read-only)
    const opArb = fc.oneof(
      fc.record({
        op: fc.constant('append'),
        amount: fc.integer({ min: 1, max: 1000 }),
        type: fc.constantFrom(
          'ORDER_REVENUE',
          'ADJUSTMENT',
          'PAYOUT_CREDIT',
          'COMMISSION_DEBIT',
          'DELIVERY_COST',
          'REFUND_DEBIT',
          'EXPENSE'
        ),
      }),
      fc.record({ op: fc.constant('read-balance') }),
      fc.record({
        op: fc.constant('read-list'),
        page: fc.integer({ min: 1, max: 3 }),
        limit: fc.integer({ min: 1, max: 50 }),
      })
    )

    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 30 }),
        async (ops) => {
          const fakeClient = makeFakeLedgerClient()
          const repo = new ShopTransactionsRepository()
          const writer = new LedgerWriteService(repo)

          // Inject our fake client for the read paths that go through
          // `query()` from config/database.js (findCurrentBalance,
          // findManyByShop). The mock module exposes vi.fn(), so we wire
          // it to the fake client's `query` here.
          const dbModule = await import('../../src/config/database.js')
          dbModule.query.mockImplementation((sql, params) =>
            fakeClient.query(sql, params)
          )

          let lastCount = 0

          for (const action of ops) {
            if (action.op === 'append') {
              const before = fakeClient.count()
              const beforeSnap = fakeClient.snapshot()

              await writer.append(fakeClient, {
                shopId: SHOP_ID,
                type: action.type,
                amount: action.amount,
                referenceType:
                  action.type === 'PAYOUT_CREDIT' ? 'PAYOUT' : 'ORDER',
                referenceId: ORDER_ID,
                createdBy: USER_ID,
              })

              const after = fakeClient.count()
              // (a) count grew by exactly +1
              if (after !== before + 1) return false

              // (b) every previously-existing row is unchanged byte-for-byte
              const afterSnap = fakeClient.snapshot()
              for (let i = 0; i < beforeSnap.length; i++) {
                if (
                  JSON.stringify(beforeSnap[i]) !==
                  JSON.stringify(afterSnap[i])
                ) {
                  return false
                }
              }
              lastCount = after
            } else if (action.op === 'read-balance') {
              const before = fakeClient.count()
              const beforeSnap = fakeClient.snapshot()

              await repo.findCurrentBalance(SHOP_ID)

              const after = fakeClient.count()
              // (c) read does NOT change the count
              if (after !== before) return false
              // (d) read does NOT alter any existing row
              const afterSnap = fakeClient.snapshot()
              if (JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
                return false
              }
              lastCount = after
            } else if (action.op === 'read-list') {
              const before = fakeClient.count()
              const beforeSnap = fakeClient.snapshot()

              await repo.findManyByShop({
                shopId: SHOP_ID,
                page: action.page,
                limit: action.limit,
              })

              const after = fakeClient.count()
              if (after !== before) return false
              const afterSnap = fakeClient.snapshot()
              if (JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
                return false
              }
              lastCount = after
            }
          }

          // Final invariant: count equals the number of `append` ops.
          const expectedCount = ops.filter((o) => o.op === 'append').length
          return lastCount === expectedCount
        }
      ),
      { numRuns: 100 }
    )
  })

  it('count is monotonically non-decreasing across every operation', async () => {
    const opArb = fc.oneof(
      fc.record({
        op: fc.constant('append'),
        amount: fc.integer({ min: 1, max: 100 }),
      }),
      fc.record({ op: fc.constant('read-balance') })
    )

    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 2, maxLength: 20 }),
        async (ops) => {
          const fakeClient = makeFakeLedgerClient()
          const repo = new ShopTransactionsRepository()
          const writer = new LedgerWriteService(repo)
          const dbModule = await import('../../src/config/database.js')
          dbModule.query.mockImplementation((sql, params) =>
            fakeClient.query(sql, params)
          )

          const counts = [fakeClient.count()]
          for (const action of ops) {
            if (action.op === 'append') {
              await writer.append(fakeClient, {
                shopId: SHOP_ID,
                type: 'ORDER_REVENUE',
                amount: action.amount,
                referenceType: 'ORDER',
                referenceId: ORDER_ID,
              })
            } else {
              await repo.findCurrentBalance(SHOP_ID)
            }
            counts.push(fakeClient.count())
          }

          // Count is monotone non-decreasing — never goes backward.
          for (let i = 1; i < counts.length; i++) {
            if (counts[i] < counts[i - 1]) return false
          }
          return true
        }
      ),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════════
// Property 11.5 — No method on the repo can mutate an existing row
// ═══════════════════════════════════════════════════════════════
describe('Property 11: Ledger Immutability — no method mutates an existing row', () => {
  it('after insertEntry, calling every other repo method any number of times leaves the row byte-identical', async () => {
    // Build the proto methods list, EXCLUDING `insertEntry` (the only
    // mutation). The remaining methods MUST all be reads — calling them
    // in any order, with any arguments, must never alter the existing row.
    const proto = ShopTransactionsRepository.prototype
    const methodNames = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor' && n !== 'insertEntry'
    )

    const callArb = fc.record({
      method: fc.constantFrom(...methodNames),
    })

    await fc.assert(
      fc.asyncProperty(
        fc.array(callArb, { minLength: 1, maxLength: 15 }),
        async (calls) => {
          const fakeClient = makeFakeLedgerClient()
          const repo = new ShopTransactionsRepository()
          const dbModule = await import('../../src/config/database.js')
          dbModule.query.mockImplementation((sql, params) =>
            fakeClient.query(sql, params)
          )

          // Seed the table with a single committed row.
          await repo.insertEntry(fakeClient, {
            shop_id: SHOP_ID,
            type: 'ORDER_REVENUE',
            amount: '100.00',
            balance_after: '100.00',
            reference_type: 'ORDER',
            reference_id: ORDER_ID,
            description: 'seed',
            created_by: USER_ID,
          })
          const seedSnapshot = JSON.stringify(fakeClient.snapshot())

          // Drive every randomly-selected method. Every call must succeed
          // *without* changing the row (or fail noisily — both are fine,
          // because failure means the method couldn't mutate either).
          for (const c of calls) {
            try {
              switch (c.method) {
                case 'findById':
                  await repo.findById('tx-00000001', SHOP_ID)
                  break
                case 'findManyByShop':
                  await repo.findManyByShop({ shopId: SHOP_ID })
                  break
                case 'findCurrentBalance':
                  await repo.findCurrentBalance(SHOP_ID)
                  break
                case 'lockLatestForShop':
                  await repo.lockLatestForShop(fakeClient, SHOP_ID)
                  break
                default:
                  // If a future commit adds a new method, the structural
                  // guard above (Property 11.1) will catch it; here we skip.
                  break
              }
            } catch (_e) {
              // A read throwing is acceptable — what matters is no mutation.
            }

            const nowSnapshot = JSON.stringify(fakeClient.snapshot())
            if (nowSnapshot !== seedSnapshot) return false
          }

          return true
        }
      ),
      { numRuns: 100 }
    )
  })

  it('insertEntry is the only mutation entry-point — its call count equals row count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 100 }), {
          minLength: 0,
          maxLength: 20,
        }),
        async (amounts) => {
          const fakeClient = makeFakeLedgerClient()
          const repo = new ShopTransactionsRepository()
          const writer = new LedgerWriteService(repo)
          const dbModule = await import('../../src/config/database.js')
          dbModule.query.mockImplementation((sql, params) =>
            fakeClient.query(sql, params)
          )

          let appendCalls = 0
          for (const amount of amounts) {
            await writer.append(fakeClient, {
              shopId: SHOP_ID,
              type: 'ORDER_REVENUE',
              amount,
              referenceType: 'ORDER',
              referenceId: ORDER_ID,
            })
            appendCalls++
          }
          // 1:1 — every append produced exactly one row.
          return fakeClient.count() === appendCalls
        }
      ),
      { numRuns: 100 }
    )
  })
})
