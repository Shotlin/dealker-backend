// Feature: multi-vendor-system, Property 18: Soft Delete Preservation
// **Validates: Requirements 15.2, 15.3**
//
// Property statement (design.md §Property 18):
//   For any soft-deleted record, it exists in DB with non-null
//   deleted_at but is excluded from standard queries.
//
// Generalisation note:
//   This property generalises to ALL soft-delete-enabled multi-vendor
//   tables — shops, shop_staff, shop_products. Every multi-vendor read
//   query MUST filter `deleted_at IS NULL` by default and MUST only
//   return soft-deleted rows when the caller explicitly opts in
//   (Requirement 15.3). We exercise the property against the
//   ShopProductsRepository as a representative because it is the only
//   multi-vendor repository that exposes the `includeDeleted` opt-in
//   publicly today. The same predicate is enforced (without an opt-in
//   path) for shops and shop_staff and is covered by the per-module
//   unit suites.
//
// Sub-properties asserted (Requirements 15.2, 15.3):
//   a) After repository.softDelete(), the row is EXCLUDED from the
//      default findMany result set.                              (15.3)
//   b) After repository.softDelete(), the row IS still present in
//      findMany({ includeDeleted: true }).                       (15.2)
//   c) After "restore" (deleted_at column cleared back to NULL —
//      modelled at the storage layer because the production
//      repository intentionally has no public `restore` method
//      today; see task 14.4 spec deliverable note), the row appears
//      in the default findMany again.                            (15.3)
//   d) Soft-deleted rows are NEVER physically removed. The count of
//      rows in the underlying storage is monotonically non-decreasing
//      across any sequence of (insert, softDelete, restore) ops.  (15.2)
//   e) Hard-DELETE never occurs — no `DELETE FROM shop_products`
//      statement is issued by any code path under test.          (15.2)
//
// Approach:
//   Drive the REAL ShopProductsRepository through a fake `query` helper
//   backed by an in-memory Map<id, row>. The fake recognises the exact
//   SQL fragments produced by the repository for create, softDelete,
//   findById and findMany (data + count) and applies the SAME
//   `deleted_at IS NULL` predicate the production SQL uses. This means
//   the soft-delete invariant is verified through the real production
//   query strings rather than at a higher-level abstraction.
//
//   Restore is modelled by directly clearing deleted_at on a row in the
//   fake storage — equivalent to an admin running
//   `UPDATE shop_products SET deleted_at = NULL …`. No production code
//   is added to support restore.
//
//   Min 100 iterations per property (project standard).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as fc from 'fast-check'
import { randomUUID } from 'node:crypto'

// ─── Mock external dependencies BEFORE importing the SUT ────
// The repository only depends on `query()` from database.js. The logger
// is mocked to keep test output clean.
const databaseMock = vi.hoisted(() => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))
vi.mock('../../src/config/database.js', () => databaseMock)

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { ShopProductsRepository } from '../../src/modules/shop-products/shop-products.repository.js'

// ─── Fake pg storage ────────────────────────────────────────
//
// Recognises the SQL fragments produced by ShopProductsRepository:
//   - INSERT INTO shop_products …                    (create)
//   - UPDATE shop_products SET deleted_at = NOW() …  (softDelete)
//   - SELECT … FROM shop_products WHERE id … AND deleted_at IS NULL
//                                                    (findById)
//   - SELECT … FROM shop_products sp LEFT JOIN products p …
//                                                    (findMany data)
//   - SELECT COUNT(*)::int AS total FROM shop_products sp …
//                                                    (findMany count)
//
// Filters by the SAME `deleted_at IS NULL` predicate the production SQL
// uses — i.e. the predicate is detected by inspecting the SQL text and
// applied against the in-memory rows. Anything the repository would not
// match in real Postgres, the fake also does not match.
function makeFakeStore() {
  /** @type {Map<string, object>} */
  const rows = new Map()
  let monotonic = 0
  const allCalls = []

  function nextCreatedAt() {
    monotonic += 1
    // Monotonically increasing Date so ORDER BY created_at DESC is stable.
    return new Date(2024, 0, 1, 0, 0, 0, monotonic)
  }

  async function query(sql, params = []) {
    const text = typeof sql === 'string' ? sql : sql?.text || ''
    allCalls.push({ text, params })

    // INSERT INTO shop_products … RETURNING …
    if (/^\s*INSERT\s+INTO\s+shop_products/i.test(text)) {
      const id = randomUUID()
      const stockQty = params[5]
      const isAvailable = params[8]
      const row = {
        id,
        shop_id: params[0],
        product_id: params[1],
        price: params[2],
        sale_price: params[3],
        cost_price: params[4],
        stock_quantity: stockQty,
        low_stock_threshold: params[6],
        max_order_qty: params[7],
        is_available: isAvailable,
        sold_out_at: params[9],
        deleted_at: null,
        created_at: nextCreatedAt(),
        updated_at: new Date(),
      }
      rows.set(id, row)
      return { rows: [{ ...row }], rowCount: 1 }
    }

    // softDelete:
    //   UPDATE shop_products
    //   SET deleted_at = NOW(), updated_at = NOW()
    //   WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL
    if (
      /^\s*UPDATE\s+shop_products\s+SET\s+deleted_at\s*=\s*NOW\(\)\s*,\s*updated_at\s*=\s*NOW\(\)\s+WHERE\s+id\s*=\s*\$1\s+AND\s+shop_id\s*=\s*\$2\s+AND\s+deleted_at\s+IS\s+NULL/i.test(
        text
      )
    ) {
      const [id, shopId] = params
      const row = rows.get(id)
      if (row && row.shop_id === shopId && row.deleted_at === null) {
        row.deleted_at = new Date()
        row.updated_at = new Date()
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    // findById:
    //   SELECT … FROM shop_products
    //   WHERE id = $1 AND shop_id = $2 AND deleted_at IS NULL
    if (
      /^\s*SELECT[\s\S]+FROM\s+shop_products\s+WHERE\s+id\s*=\s*\$1\s+AND\s+shop_id\s*=\s*\$2\s+AND\s+deleted_at\s+IS\s+NULL\s*$/i.test(
        text
      )
    ) {
      const [id, shopId] = params
      const row = rows.get(id)
      if (row && row.shop_id === shopId && row.deleted_at === null) {
        return { rows: [{ ...row }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    // findMany count:
    //   SELECT COUNT(*)::int AS total FROM shop_products sp
    //   LEFT JOIN products p … WHERE …
    if (
      /^\s*SELECT\s+COUNT\(\*\)::int\s+AS\s+total\s+FROM\s+shop_products\s+sp/i.test(
        text
      )
    ) {
      const [shopId] = params
      const includeDeleted = !/sp\.deleted_at\s+IS\s+NULL/i.test(text)
      const matching = [...rows.values()].filter(
        (r) =>
          r.shop_id === shopId && (includeDeleted || r.deleted_at === null)
      )
      return { rows: [{ total: matching.length }], rowCount: 1 }
    }

    // findMany data:
    //   SELECT sp.…, p.name AS product_name, …
    //   FROM shop_products sp LEFT JOIN products p …
    //   WHERE … ORDER BY sp.created_at DESC LIMIT $N OFFSET $N+1
    if (
      /^\s*SELECT[\s\S]+FROM\s+shop_products\s+sp\s+LEFT\s+JOIN\s+products\s+p/i.test(
        text
      )
    ) {
      const [shopId, ...rest] = params
      // limit / offset are the last two params
      const limit = rest[rest.length - 2]
      const offset = rest[rest.length - 1]
      const includeDeleted = !/sp\.deleted_at\s+IS\s+NULL/i.test(text)
      const matching = [...rows.values()]
        .filter(
          (r) =>
            r.shop_id === shopId && (includeDeleted || r.deleted_at === null)
        )
        // ORDER BY sp.created_at DESC
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(offset, offset + limit)
        // findMany SELECT also projects the joined product_name /
        // product_image_url columns; in our model they are unset.
        .map((r) => ({
          ...r,
          product_name: null,
          product_image_url: null,
        }))
      return { rows: matching, rowCount: matching.length }
    }

    // Unknown SQL — surface loudly so the test fails on uncovered code paths.
    throw new Error(`Fake pg: unhandled SQL\n${text}`)
  }

  function restore(id) {
    const row = rows.get(id)
    if (row) {
      row.deleted_at = null
      row.updated_at = new Date()
      return true
    }
    return false
  }

  return {
    query,
    rows, // raw access for assertions
    restore, // model-only — see file header (c)
    allCalls, // for hard-DELETE detection
  }
}

// ─── Test fixtures ─────────────────────────────────────────
const SHOP_ID = '11111111-1111-1111-1111-111111111111'

const shopProductInputArb = () =>
  fc.record({
    product_id: fc.uuid(),
    price: fc.integer({ min: 1, max: 10_000 }),
    sale_price: fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null }),
    cost_price: fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: null }),
    stock_quantity: fc.integer({ min: 0, max: 100 }),
    low_stock_threshold: fc.integer({ min: 0, max: 10 }),
    max_order_qty: fc.integer({ min: 1, max: 50 }),
    is_available: fc.boolean(),
  })

// ─── Operation arbitrary ───────────────────────────────────
//
// Each operation is one of:
//   { kind: 'insert',     input }
//   { kind: 'softDelete', pick }   // 0..1 fraction → idx into live snapshot
//   { kind: 'restore',    pick }   // 0..1 fraction → idx into deleted snapshot
//
// The pick fraction is resolved against the live snapshot at execution
// time so the generator stays stateless.
const opArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('insert'),
      input: shopProductInputArb(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('softDelete'),
      pick: fc.double({ min: 0, max: 0.999_999, noNaN: true }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('restore'),
      pick: fc.double({ min: 0, max: 0.999_999, noNaN: true }),
    }),
  }
)

const sequenceArb = fc.array(opArb, { minLength: 3, maxLength: 25 })

beforeEach(() => {
  vi.clearAllMocks()
})

// ═══════════════════════════════════════════════════════════
// Property 18a — Default findMany excludes soft-deleted rows;
//                include-deleted findMany returns every row;
//                physical row count never decreases;
//                no hard-DELETE is ever issued.
// ═══════════════════════════════════════════════════════════
describe('Property 18: Soft Delete Preservation', () => {
  it('default queries exclude deleted rows; include-deleted returns all rows; physical row count never decreases; no hard-DELETE is ever issued', async () => {
    await fc.assert(
      fc.asyncProperty(sequenceArb, async (operations) => {
        const store = makeFakeStore()
        databaseMock.query.mockImplementation(store.query)
        const repo = new ShopProductsRepository()

        const insertedIds = []
        let lastPhysicalCount = 0

        for (const op of operations) {
          if (op.kind === 'insert') {
            const created = await repo.create({
              shop_id: SHOP_ID,
              product_id: op.input.product_id,
              price: op.input.price,
              sale_price: op.input.sale_price,
              cost_price: op.input.cost_price,
              stock_quantity: op.input.stock_quantity,
              low_stock_threshold: op.input.low_stock_threshold,
              max_order_qty: op.input.max_order_qty,
              is_available: op.input.is_available,
            })
            expect(created).toBeTruthy()
            expect(created.deleted_at).toBeNull()
            insertedIds.push(created.id)
          } else if (op.kind === 'softDelete') {
            const liveIds = insertedIds.filter(
              (id) => store.rows.get(id).deleted_at === null
            )
            if (liveIds.length === 0) continue
            const id = liveIds[Math.floor(op.pick * liveIds.length)]

            const ok = await repo.softDelete(id, SHOP_ID)
            expect(ok).toBe(true)

            // Sub-property a: row excluded from default findById.
            const lookup = await repo.findById(id, SHOP_ID)
            expect(lookup).toBeNull()

            // Sub-property d: deleted_at flipped to a Date (not removed).
            const physical = store.rows.get(id)
            expect(physical).toBeTruthy()
            expect(physical.deleted_at).toBeInstanceOf(Date)
          } else if (op.kind === 'restore') {
            const deletedIds = insertedIds.filter(
              (id) => store.rows.get(id).deleted_at !== null
            )
            if (deletedIds.length === 0) continue
            const id = deletedIds[Math.floor(op.pick * deletedIds.length)]
            const ok = store.restore(id)
            expect(ok).toBe(true)
          }

          // Sub-property d: row count never decreases between ops.
          expect(store.rows.size).toBeGreaterThanOrEqual(lastPhysicalCount)
          lastPhysicalCount = store.rows.size
        }

        // ─── Final-state invariants ─────────────────────────────
        const allRows = [...store.rows.values()]
        const liveRows = allRows.filter((r) => r.deleted_at === null)
        const deletedRows = allRows.filter((r) => r.deleted_at !== null)

        // Sub-properties a + b: findMany's two modes equal the in-memory
        // model's two views.
        const defaultPage = await repo.findMany({
          shopId: SHOP_ID,
          page: 1,
          limit: 100,
        })
        const includeDeletedPage = await repo.findMany({
          shopId: SHOP_ID,
          page: 1,
          limit: 100,
          includeDeleted: true,
        })

        expect(defaultPage.total).toBe(liveRows.length)
        expect(new Set(defaultPage.items.map((r) => r.id))).toEqual(
          new Set(liveRows.map((r) => r.id))
        )
        // No item returned by the default query is soft-deleted.
        for (const item of defaultPage.items) {
          expect(item.deleted_at).toBeNull()
        }

        expect(includeDeletedPage.total).toBe(allRows.length)
        expect(new Set(includeDeletedPage.items.map((r) => r.id))).toEqual(
          new Set(allRows.map((r) => r.id))
        )

        // The include-deleted set is a superset of the default set.
        const defaultIds = new Set(defaultPage.items.map((r) => r.id))
        const includeIds = new Set(includeDeletedPage.items.map((r) => r.id))
        for (const id of defaultIds) {
          expect(includeIds.has(id)).toBe(true)
        }
        // Every soft-deleted row appears in include-deleted but NOT default.
        for (const row of deletedRows) {
          expect(includeIds.has(row.id)).toBe(true)
          expect(defaultIds.has(row.id)).toBe(false)
        }

        // Sub-property d: every row that was ever inserted is still in
        // physical storage (no row vanished even if it was soft-deleted).
        for (const id of insertedIds) {
          expect(store.rows.has(id)).toBe(true)
        }
        expect(store.rows.size).toBe(insertedIds.length)

        // Sub-property e: no hard-DELETE was ever issued.
        for (const call of store.allCalls) {
          expect(/\bDELETE\s+FROM\s+shop_products\b/i.test(call.text)).toBe(
            false
          )
        }
      }),
      { numRuns: 100 }
    )
  })
})

// ═══════════════════════════════════════════════════════════
// Property 18b — Restore round-trip identity
//
// Asserts the third clause of Property 18: after a row is soft-deleted
// and then restored, the default findMany returns to including the row.
// This is asserted using the storage-fake restore helper because the
// production repository does not expose a public restore method today
// (see file header note (c) and task 14.4 spec deliverable).
// ═══════════════════════════════════════════════════════════
describe('Property 18: Soft Delete Preservation — restore round trip', () => {
  it('softDelete → restore returns the row to default visibility without removing it from physical storage', async () => {
    await fc.assert(
      fc.asyncProperty(shopProductInputArb(), async (input) => {
        const store = makeFakeStore()
        databaseMock.query.mockImplementation(store.query)
        const repo = new ShopProductsRepository()

        const created = await repo.create({
          shop_id: SHOP_ID,
          ...input,
        })

        // Initially visible by default.
        let snapshot = await repo.findMany({
          shopId: SHOP_ID,
          page: 1,
          limit: 100,
        })
        expect(snapshot.items.map((r) => r.id)).toContain(created.id)

        // Soft-delete → invisible by default, visible with includeDeleted.
        await repo.softDelete(created.id, SHOP_ID)

        snapshot = await repo.findMany({
          shopId: SHOP_ID,
          page: 1,
          limit: 100,
        })
        expect(snapshot.items.map((r) => r.id)).not.toContain(created.id)

        const includeSnap = await repo.findMany({
          shopId: SHOP_ID,
          page: 1,
          limit: 100,
          includeDeleted: true,
        })
        expect(includeSnap.items.map((r) => r.id)).toContain(created.id)

        // Restore → visible by default again.
        store.restore(created.id)

        snapshot = await repo.findMany({
          shopId: SHOP_ID,
          page: 1,
          limit: 100,
        })
        expect(snapshot.items.map((r) => r.id)).toContain(created.id)

        // Storage size never changed across the round trip.
        expect(store.rows.size).toBe(1)
      }),
      { numRuns: 100 }
    )
  })
})
