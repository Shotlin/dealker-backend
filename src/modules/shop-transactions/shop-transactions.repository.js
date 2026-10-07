import { query } from '../../config/database.js'

/**
 * Shop Transactions repository — append-only ledger SQL.
 *
 * Conventions (Requirements 14.5, 14.7):
 *   - NEVER `SELECT *` — every column is named explicitly
 *   - All queries use parameterized placeholders ($1, $2…)
 *   - Append-only enforcement (Requirements 7.3, 7.4, 15.1):
 *       * NO `update*` / `delete*` / `softDelete*` methods exist.
 *       * The only mutation is `insertEntry()`, which executes a single
 *         INSERT inside a caller-owned transaction.
 *   - Reads:
 *       * `findManyByShop()` — paginated, filterable history
 *       * `findById()` — single-row lookup scoped to a shop
 *       * `findCurrentBalance()` — latest balance_after for a shop (cheap)
 *       Read paths run every returned row through the static helper
 *       `ShopTransactionsRepository.normalizeType(row)` so callers see a
 *       derived `type_v2` field plus a re-derived `direction` for legacy
 *       rows (R24.15, design §9.1).
 *   - Internal ledger write:
 *       * `lockLatestForShop(client, shopId)` — SELECT … FOR UPDATE on the
 *         most recent row. Returns null if the shop has no entries yet.
 *       * `insertEntry(client, row)` — appends a precomputed row. The caller
 *         (LedgerWriteService) is responsible for computing balance_after
 *         under the FOR UPDATE lock.
 *
 * Migration references:
 *   - 035_shop_transactions.sql  (initial table)
 *   - 045_shop_transactions_v2.sql (R24.1, R24.2, R24.15, R24.16 — adds
 *     `direction`, `status`, `metadata`, `rider_id`, `order_id` and the
 *     Transaction_Type_V2 ∪ legacy CHECK constraint)
 */
export class ShopTransactionsRepository {
  // ────────────────────────────────────────────────────────
  // Column projection — keep in sync with migrations 035 + 045
  // ────────────────────────────────────────────────────────
  static SELECT_COLUMNS = `
    id, shop_id, type, amount, balance_after,
    reference_type, reference_id, description,
    direction, status, metadata, rider_id, order_id,
    created_by, created_at
  `

  // ────────────────────────────────────────────────────────
  // V2 vocabulary (R24.1, design §9.1)
  // ────────────────────────────────────────────────────────
  static V2_TYPES = Object.freeze([
    'ORDER_REVENUE',
    'PLATFORM_COMMISSION',
    'DELIVERY_FEE',
    'RIDER_COST',
    'REFUND',
    'PAYOUT',
    'ADJUSTMENT',
    'COUPON_DISCOUNT',
    'TAX',
  ])

  // Legacy types preserved for read-back compatibility (R24.15).
  static LEGACY_TYPES = Object.freeze([
    'COMMISSION_DEBIT',
    'DELIVERY_COST',
    'REFUND_DEBIT',
    'PAYOUT_CREDIT',
    'EXPENSE',
  ])

  // Union accepted by migration 045's chk_shop_transactions_type CHECK.
  static ALLOWED_TYPES = Object.freeze([
    ...ShopTransactionsRepository.V2_TYPES,
    ...ShopTransactionsRepository.LEGACY_TYPES,
  ])

  static ALLOWED_DIRECTIONS = Object.freeze(['CREDIT', 'DEBIT'])
  static ALLOWED_STATUSES = Object.freeze(['PENDING', 'POSTED', 'REVERSED'])

  // Legacy → V2 mapping for read-time normalization.
  // Per task notes / design §9.1 / R24.15–R24.16:
  //   COMMISSION_DEBIT → PLATFORM_COMMISSION (direction=DEBIT)
  //   DELIVERY_COST    → RIDER_COST          (direction=DEBIT)
  //   REFUND_DEBIT     → REFUND              (direction=DEBIT)
  //   PAYOUT_CREDIT    → PAYOUT              (direction=DEBIT — new ledger
  //                                            contract per R24.16; legacy
  //                                            rows are surfaced with the
  //                                            corrected direction so the
  //                                            dashboard renders them as a
  //                                            balance reduction)
  //   EXPENSE          → kept as-is (no V2 equivalent in migration 045 CHECK;
  //                                  treated as a legacy alias)
  // V2 type names pass through unchanged.
  static LEGACY_TYPE_MAP = Object.freeze({
    COMMISSION_DEBIT: { type_v2: 'PLATFORM_COMMISSION', direction: 'DEBIT' },
    DELIVERY_COST: { type_v2: 'RIDER_COST', direction: 'DEBIT' },
    REFUND_DEBIT: { type_v2: 'REFUND', direction: 'DEBIT' },
    PAYOUT_CREDIT: { type_v2: 'PAYOUT', direction: 'DEBIT' },
    EXPENSE: { type_v2: 'EXPENSE', direction: 'DEBIT' },
  })

  // ════════════════════════════════════════════════════════
  // READ-TIME NORMALIZATION HELPER
  // ════════════════════════════════════════════════════════

  /**
   * Map a legacy `type` value to the Transaction_Type_V2 vocabulary and
   * re-derive `direction` for legacy rows whose stored direction is the
   * migration 045 default ('CREDIT') rather than a real backfilled value.
   *
   * Pure / non-mutating: returns a new shallow-cloned row with a derived
   * `type_v2` field added (and `direction` overridden for legacy rows). The
   * caller's argument is left untouched, which keeps the append-only
   * invariant (Property 11) intact for snapshot-based tests.
   *
   * V2 type names pass through unchanged — only the legacy aliases are
   * remapped. Returns `null` when given `null` (mirroring `findById`'s
   * "no row" return shape).
   *
   * Implemented as a static method so it does not appear on the prototype's
   * enumerable surface; the append-only structural guard
   * (`ledger-immutability.property.test.js#Property 11.1`) only inspects
   * prototype methods.
   *
   * @param {object|null} row - a row shaped like SELECT_COLUMNS, or null.
   * @returns {object|null}
   */
  static normalizeType(row) {
    if (!row) return null
    const mapping = ShopTransactionsRepository.LEGACY_TYPE_MAP[row.type]
    if (!mapping) {
      // V2 type (or unknown — surface via type_v2 = type).
      return { ...row, type_v2: row.type }
    }
    return {
      ...row,
      type_v2: mapping.type_v2,
      direction: mapping.direction,
    }
  }

  // ════════════════════════════════════════════════════════
  // READ-ONLY QUERIES (used by the public API)
  // ════════════════════════════════════════════════════════

  /**
   * Find a single ledger entry by id, scoped to a shop.
   * Result is run through `normalizeType` so legacy rows surface their V2
   * canonical type and re-derived direction (R24.15).
   *
   * @param {string} id - shop_transaction UUID
   * @param {string} shopId - Shop UUID for scope enforcement (Req 13.6)
   * @returns {Promise<object|null>}
   */
  async findById(id, shopId) {
    const { rows } = await query(
      `SELECT ${ShopTransactionsRepository.SELECT_COLUMNS}
         FROM shop_transactions
        WHERE id = $1 AND shop_id = $2`,
      [id, shopId]
    )
    return ShopTransactionsRepository.normalizeType(rows[0] || null)
  }

  /**
   * Paginated list of ledger entries for a shop, newest first.
   * Uses idx_shop_transactions_shop_created (shop_id, created_at DESC) when
   * unfiltered, and idx_shop_transactions_shop_type_created when `type` is set.
   * Every returned row is run through `normalizeType` so dashboard consumers
   * see V2 canonical types (R24.15).
   *
   * @param {object} filters
   * @param {string} filters.shopId
   * @param {number} [filters.page=1]
   * @param {number} [filters.limit=50]
   * @param {string} [filters.type]
   * @param {string} [filters.reference_type]
   * @param {string} [filters.reference_id]
   * @param {Date}   [filters.from] - inclusive
   * @param {Date}   [filters.to]   - exclusive
   * @returns {Promise<{items: Array, total: number}>}
   */
  async findManyByShop({
    shopId,
    page = 1,
    limit = 50,
    type,
    reference_type,
    reference_id,
    from,
    to,
  }) {
    const offset = (page - 1) * limit
    const conditions = ['shop_id = $1']
    const params = [shopId]
    let idx = 2

    if (type) {
      conditions.push(`type = $${idx++}`)
      params.push(type)
    }
    if (reference_type) {
      conditions.push(`reference_type = $${idx++}`)
      params.push(reference_type)
    }
    if (reference_id) {
      conditions.push(`reference_id = $${idx++}`)
      params.push(reference_id)
    }
    if (from instanceof Date) {
      conditions.push(`created_at >= $${idx++}`)
      params.push(from)
    }
    if (to instanceof Date) {
      conditions.push(`created_at < $${idx++}`)
      params.push(to)
    }

    const where = conditions.join(' AND ')

    const [dataResult, countResult] = await Promise.all([
      query(
        `SELECT ${ShopTransactionsRepository.SELECT_COLUMNS}
           FROM shop_transactions
          WHERE ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*)::int AS total
           FROM shop_transactions
          WHERE ${where}`,
        params
      ),
    ])

    return {
      items: dataResult.rows.map((r) =>
        ShopTransactionsRepository.normalizeType(r)
      ),
      total: countResult.rows[0]?.total || 0,
    }
  }

  /**
   * Read the latest balance_after for a shop (current balance).
   * Cheap O(1) read backed by idx_shop_transactions_shop_created.
   * Returns "0.00" when the shop has no ledger entries yet (Requirement 7.8).
   *
   * @param {string} shopId
   * @returns {Promise<{ balance: string, last_entry_at: Date|null }>}
   */
  async findCurrentBalance(shopId) {
    const { rows } = await query(
      `SELECT balance_after, created_at
         FROM shop_transactions
        WHERE shop_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [shopId]
    )
    if (!rows[0]) {
      return { balance: '0.00', last_entry_at: null }
    }
    return {
      balance: String(rows[0].balance_after),
      last_entry_at: rows[0].created_at,
    }
  }

  // ════════════════════════════════════════════════════════
  // TRANSACTIONAL HELPERS — caller owns BEGIN/COMMIT
  // ════════════════════════════════════════════════════════
  //
  // These are the ONLY mutation paths exposed by the repository.
  // They do not mutate existing rows — `insertEntry` only INSERTs.
  // No `update*` / `delete*` / `softDelete*` method exists, so the
  // append-only invariant (Req 7.3, 7.4, 15.1) is enforced structurally.

  /**
   * Lock the most recent ledger row for a shop and return it.
   * Used by LedgerWriteService to read the previous balance under a row-level
   * lock before computing balance_after (Requirement 7.7).
   *
   * Returns null when the shop has no prior entries — the caller MUST treat
   * the previous balance as 0.00 in that case (Requirement 7.8).
   *
   * @param {import('pg').PoolClient} client - Transactional client (BEGIN already issued)
   * @param {string} shopId
   * @returns {Promise<object|null>}
   */
  async lockLatestForShop(client, shopId) {
    const { rows } = await client.query(
      `SELECT ${ShopTransactionsRepository.SELECT_COLUMNS}
         FROM shop_transactions
        WHERE shop_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [shopId]
    )
    return rows[0] || null
  }

  /**
   * Append a ledger entry inside an open transaction.
   *
   * Caller (LedgerWriteService) is responsible for:
   *   - computing balance_after under the FOR UPDATE lock,
   *   - committing or rolling back the surrounding transaction.
   *
   * V2 columns (R24.1, R24.2): `direction`, `status`, `metadata`, `rider_id`,
   * `order_id` are accepted on the `row` argument and persisted explicitly.
   * Each defaults to the migration 045 column default when omitted, so legacy
   * call sites that have not yet been migrated to V2 keep working unchanged:
   *   - direction defaults to 'CREDIT' (matches DB DEFAULT 'CREDIT')
   *   - status    defaults to 'POSTED' (matches DB DEFAULT 'POSTED')
   *   - metadata  defaults to {}       (matches DB DEFAULT '{}'::jsonb)
   *   - rider_id  defaults to NULL
   *   - order_id  defaults to NULL
   *
   * Validation (defence-in-depth on top of the DB CHECK constraints):
   *   - `type`      must be in V2 ∪ legacy union (migration 045 CHECK)
   *   - `direction` must be in {CREDIT, DEBIT}
   *   - `status`    must be in {PENDING, POSTED, REVERSED}
   * On invalid input we throw a TypeError with code `LEDGER_VALIDATION_ERROR`
   * before issuing the INSERT so the caller can surface a clean 400 to the
   * client without burning a round-trip on a CHECK violation.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} row
   * @param {string} row.shop_id
   * @param {string} row.type
   * @param {number|string} row.amount
   * @param {number|string} row.balance_after
   * @param {string} row.reference_type
   * @param {string|null} [row.reference_id]
   * @param {string|null} [row.description]
   * @param {string|null} [row.created_by]
   * @param {string} [row.direction='CREDIT']
   * @param {string} [row.status='POSTED']
   * @param {object} [row.metadata={}]
   * @param {string|null} [row.rider_id]
   * @param {string|null} [row.order_id]
   * @returns {Promise<object>} the inserted row
   */
  async insertEntry(client, row) {
    const direction = row.direction ?? 'CREDIT'
    const status = row.status ?? 'POSTED'
    const metadata = row.metadata ?? {}

    // Defence-in-depth validation (mirrors migration 045 CHECK constraints).
    if (!ShopTransactionsRepository.ALLOWED_TYPES.includes(row.type)) {
      const err = new TypeError(
        `Invalid shop_transactions.type: ${JSON.stringify(row.type)}`
      )
      err.code = 'LEDGER_VALIDATION_ERROR'
      throw err
    }
    if (!ShopTransactionsRepository.ALLOWED_DIRECTIONS.includes(direction)) {
      const err = new TypeError(
        `Invalid shop_transactions.direction: ${JSON.stringify(direction)}`
      )
      err.code = 'LEDGER_VALIDATION_ERROR'
      throw err
    }
    if (!ShopTransactionsRepository.ALLOWED_STATUSES.includes(status)) {
      const err = new TypeError(
        `Invalid shop_transactions.status: ${JSON.stringify(status)}`
      )
      err.code = 'LEDGER_VALIDATION_ERROR'
      throw err
    }

    // metadata is JSONB — pg expects a JSON string when we cast with ::jsonb.
    const metadataJson =
      typeof metadata === 'string' ? metadata : JSON.stringify(metadata)

    const { rows } = await client.query(
      `INSERT INTO shop_transactions (
         shop_id, type, amount, balance_after,
         reference_type, reference_id, description, created_by,
         direction, status, metadata, rider_id, order_id
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, $11::jsonb, $12, $13
       )
       RETURNING ${ShopTransactionsRepository.SELECT_COLUMNS}`,
      [
        row.shop_id,
        row.type,
        row.amount,
        row.balance_after,
        row.reference_type,
        row.reference_id ?? null,
        row.description ?? null,
        row.created_by ?? null,
        direction,
        status,
        metadataJson,
        row.rider_id ?? null,
        row.order_id ?? null,
      ]
    )
    return rows[0]
  }
}
