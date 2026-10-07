import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external collaborators BEFORE importing the SUT ─
// We do NOT execute real SQL — every assertion is on the SQL string and
// parameter array passed to query()/getClient().query() so the test stays
// pure-unit. Mirrors the convention used in shop-products.service.test.js.
vi.mock('../../../src/config/database.js', () => ({
  query: vi.fn(),
  getClient: vi.fn(),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { AllocationRepository } from '../../../src/modules/allocation/allocation.repository.js'
import { query, getClient } from '../../../src/config/database.js'

// ─── Fixtures ────────────────────────────────────────────
const USER_ID = '11111111-1111-1111-1111-111111111111'
const SHOP_A = '22222222-2222-2222-2222-22222222222a'
const SHOP_B = '22222222-2222-2222-2222-22222222222b'

/** Return the SQL text from a query mock invocation, normalised to single
 *  spaces so multi-line strings can be inspected with simple substring
 *  assertions. */
function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * Build a transactional pg client mock that records the BEGIN/COMMIT/
 * ROLLBACK sequence so we can assert ordering and rollback behaviour.
 * Mirrors makeTxClientMock() in tests/unit/shop-products.
 */
function makeTxClientMock() {
  const calls = []
  const client = {
    calls,
    query: vi.fn(async (text, params) => {
      const sqlText = typeof text === 'string' ? text : text.text
      calls.push({ sql: normalize(sqlText), params })
      const upper = sqlText.trim().toUpperCase()
      if (upper.startsWith('BEGIN') || upper.startsWith('COMMIT') || upper.startsWith('ROLLBACK')) {
        return { rows: [], rowCount: 0 }
      }
      if (upper.startsWith('DELETE')) {
        return { rows: [], rowCount: 1 }
      }
      // INSERT…ON CONFLICT
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return client
}

// ═══════════════════════════════════════════════════════════
// findByUserId() — Requirement 4.5 (active + non-deleted only)
// ═══════════════════════════════════════════════════════════
describe('AllocationRepository.findByUserId()', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AllocationRepository()
  })

  it('joins user_shop_allocations with shops and excludes inactive/soft-deleted', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findByUserId(USER_ID)

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)

    // JOIN on shops
    expect(text).toMatch(/FROM user_shop_allocations a\s+JOIN shops s ON s\.id = a\.shop_id/)
    // Filter on user_id, is_active, deleted_at IS NULL
    expect(text).toContain('a.user_id = $1')
    expect(text).toContain('s.is_active = true')
    expect(text).toContain('s.deleted_at IS NULL')

    // Parameterised — ensure user id is the only parameter
    expect(params).toEqual([USER_ID])
  })

  it('orders by is_primary DESC, distance_km ASC NULLS LAST, allocated_at ASC', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findByUserId(USER_ID)

    const text = normalize(query.mock.calls[0][0])
    expect(text).toContain('ORDER BY a.is_primary DESC')
    expect(text).toContain('a.distance_km ASC NULLS LAST')
    expect(text).toContain('a.allocated_at ASC')
  })

  it('returns the rows from query() unchanged', async () => {
    const rows = [
      {
        id: 'a-1',
        shop_id: SHOP_A,
        name: 'Fresh Mart',
        distance_km: 1.0,
        matched_pincode: '560001',
        is_primary: true,
        allocated_at: '2024-01-01T00:00:00Z',
      },
    ]
    query.mockResolvedValue({ rows })

    const result = await repo.findByUserId(USER_ID)
    expect(result).toBe(rows)
  })
})

// ═══════════════════════════════════════════════════════════
// findShopsByPincode() — Req 4.1 (GIN-friendly = ANY(...))
// ═══════════════════════════════════════════════════════════
describe('AllocationRepository.findShopsByPincode()', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AllocationRepository()
  })

  it('uses GIN-friendly $1 = ANY(serviceable_pincodes) lookup with parameterized pincode', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findShopsByPincode('560001')

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)

    expect(text).toContain('$1 = ANY(s.serviceable_pincodes)')
    expect(text).toContain('s.is_active = true')
    expect(text).toContain('s.deleted_at IS NULL')
    expect(params).toEqual(['560001'])
  })

  it('computes haversine distance when coords are supplied (lat=$2, lng=$3)', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findShopsByPincode('560001', { lat: 12.97, lng: 77.59 })

    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)

    // Haversine formula present and parameterized on $2/$3
    expect(text).toMatch(/6371 \* acos/)
    expect(text).toContain('radians($2::float8)')
    expect(text).toContain('radians($3::float8)')
    expect(params).toEqual(['560001', 12.97, 77.59])
  })

  it('returns NULL distance_km when coords are missing (single-param query)', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findShopsByPincode('560001')

    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)
    expect(text).toContain('NULL::numeric(7,2) AS distance_km')
    expect(params).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════
// findShopsByRadius() — Req 4.2 (haversine in SQL, parameterized)
// ═══════════════════════════════════════════════════════════
describe('AllocationRepository.findShopsByRadius()', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AllocationRepository()
  })

  it('parameterizes lat=$1, lng=$2 and filters distance_km <= delivery_radius_km', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findShopsByRadius(12.97, 77.59)

    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)

    // Haversine: lat is $1, lng is $2 — inverted from the pincode helper
    expect(text).toContain('radians($1::float8)')
    expect(text).toContain('radians($2::float8)')
    // Earth-radius constant
    expect(text).toMatch(/6371 \* acos/)
    // Final distance ≤ each shop's own radius
    expect(text).toContain('distance_km <= delivery_radius_km')
    // Active + non-deleted shops only
    expect(text).toContain('s.is_active = true')
    expect(text).toContain('s.deleted_at IS NULL')

    expect(params).toEqual([12.97, 77.59])
  })

  it('clamps the acos argument with LEAST/GREATEST to avoid domain errors', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findShopsByRadius(12.97, 77.59)

    const text = normalize(query.mock.calls[0][0])
    expect(text).toContain('LEAST(1.0, GREATEST(-1.0,')
  })

  it('excludes pincode_only shops — radius must never match one', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findShopsByRadius(12.97, 77.59)

    const text = normalize(query.mock.calls[0][0])
    expect(text).toContain('s.pincode_only = false')
  })
})

// ═══════════════════════════════════════════════════════════
// replaceForUser() — Req 4.3 (atomic replace inside a transaction)
// ═══════════════════════════════════════════════════════════
describe('AllocationRepository.replaceForUser()', () => {
  let repo
  let client

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AllocationRepository()
    client = makeTxClientMock()
    getClient.mockResolvedValue(client)
  })

  it('runs BEGIN → DELETE → INSERT…ON CONFLICT → COMMIT in order and releases client', async () => {
    const allocations = [
      {
        shop_id: SHOP_A,
        distance_km: 1.5,
        matched_pincode: '560001',
        is_primary: true,
      },
      {
        shop_id: SHOP_B,
        distance_km: 2.5,
        matched_pincode: null,
        is_primary: false,
      },
    ]

    await repo.replaceForUser(USER_ID, allocations)

    const seq = client.calls.map((c) => c.sql)
    // Sequence assertion
    expect(seq[0]).toMatch(/^BEGIN/i)
    expect(seq[1]).toMatch(/^DELETE FROM user_shop_allocations WHERE user_id = \$1/i)
    expect(seq[2]).toMatch(/^INSERT INTO user_shop_allocations/i)
    expect(seq[2]).toContain('ON CONFLICT (user_id, shop_id) DO UPDATE')
    expect(seq[3]).toMatch(/^INSERT INTO user_shop_allocations/i)
    expect(seq[seq.length - 1]).toMatch(/^COMMIT/i)

    // DELETE param is the user id
    expect(client.calls[1].params).toEqual([USER_ID])

    // INSERT params follow the (user_id, shop_id, distance_km, matched_pincode, is_primary) shape
    expect(client.calls[2].params).toEqual([
      USER_ID,
      SHOP_A,
      1.5,
      '560001',
      true,
    ])
    expect(client.calls[3].params).toEqual([
      USER_ID,
      SHOP_B,
      2.5,
      null,
      false,
    ])

    // Always release the pool client
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('rolls back and rethrows when an INSERT fails', async () => {
    const allocations = [
      {
        shop_id: SHOP_A,
        distance_km: 1.0,
        matched_pincode: null,
        is_primary: true,
      },
    ]

    // Make the INSERT fail
    let insertSeen = false
    client.query.mockImplementation(async (text) => {
      const sqlText = typeof text === 'string' ? text : text.text
      const upper = sqlText.trim().toUpperCase()
      client.calls.push({ sql: normalize(sqlText) })
      if (upper.startsWith('INSERT') && !insertSeen) {
        insertSeen = true
        throw new Error('unique_violation')
      }
      return { rows: [], rowCount: 1 }
    })

    await expect(
      repo.replaceForUser(USER_ID, allocations)
    ).rejects.toThrow('unique_violation')

    const seq = client.calls.map((c) => c.sql)
    expect(seq.some((s) => /^BEGIN/i.test(s))).toBe(true)
    expect(seq.some((s) => /^ROLLBACK/i.test(s))).toBe(true)
    expect(seq.some((s) => /^COMMIT/i.test(s))).toBe(false)

    // Even on error, the pool client must be released
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('handles the empty-allocations case with BEGIN → DELETE → COMMIT only', async () => {
    await repo.replaceForUser(USER_ID, [])

    const seq = client.calls.map((c) => c.sql)
    expect(seq[0]).toMatch(/^BEGIN/i)
    expect(seq[1]).toMatch(/^DELETE FROM user_shop_allocations/i)
    expect(seq[2]).toMatch(/^COMMIT/i)
    expect(seq.some((s) => /^INSERT/i.test(s))).toBe(false)
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════
// findUsersAffectedByShop() — Req 4.8/4.9 (keyset pagination, LIMIT clamp)
// ═══════════════════════════════════════════════════════════
describe('AllocationRepository.findUsersAffectedByShop()', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AllocationRepository()
  })

  it('uses keyset pagination (u.id > $N) when afterUserId is supplied', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findUsersAffectedByShop(SHOP_A, {
      afterUserId: USER_ID,
      limit: 50,
    })

    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)

    expect(text).toMatch(/AND u\.id > \$2/)
    expect(text).toContain('ORDER BY u.id ASC')
    expect(text).toContain('LIMIT $3')
    expect(params).toEqual([SHOP_A, USER_ID, 50])
  })

  it('also selects users who already hold an allocation to the shop, so stale allocations get recomputed away', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findUsersAffectedByShop(SHOP_A, { limit: 10 })

    const text = normalize(query.mock.calls[0][0])
    expect(text).toContain('FROM user_shop_allocations ua')
    expect(text).toMatch(/ua\.user_id = u\.id AND ua\.shop_id = t\.id/)
    // Existing matching rules are untouched.
    expect(text).toContain('addr.pincode = ANY(t.serviceable_pincodes)')
    expect(text).toContain('NOT t.pincode_only')
  })

  it('omits the cursor clause when afterUserId is null', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findUsersAffectedByShop(SHOP_A, { limit: 100 })

    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)

    expect(text).not.toMatch(/u\.id > \$/)
    expect(text).toContain('LIMIT $2')
    expect(params).toEqual([SHOP_A, 100])
  })

  it('clamps limit to the inclusive range [1, 1000] for meaningful inputs', async () => {
    query.mockResolvedValue({ rows: [] })

    // Above the upper bound → 1000
    await repo.findUsersAffectedByShop(SHOP_A, { limit: 99999 })
    expect(query.mock.calls[0][1].at(-1)).toBe(1000)

    // Negative → clamped to 1
    await repo.findUsersAffectedByShop(SHOP_A, { limit: -5 })
    expect(query.mock.calls[1][1].at(-1)).toBe(1)

    // Within range → preserved
    await repo.findUsersAffectedByShop(SHOP_A, { limit: 50 })
    expect(query.mock.calls[2][1].at(-1)).toBe(50)

    // Falsy (0 / NaN) → falls back to default 200, then clamp is a no-op
    await repo.findUsersAffectedByShop(SHOP_A, { limit: 0 })
    expect(query.mock.calls[3][1].at(-1)).toBe(200)
  })

  it('defaults the limit to 200 when omitted', async () => {
    query.mockResolvedValue({ rows: [] })
    await repo.findUsersAffectedByShop(SHOP_A)
    expect(query.mock.calls[0][1].at(-1)).toBe(200)
  })

  it('coerces lat/lng strings from pg numeric to JS Number in returned rows', async () => {
    query.mockResolvedValue({
      rows: [
        {
          user_id: USER_ID,
          lat: '12.97',
          lng: '77.59',
          pincode: '560001',
        },
      ],
    })

    const rows = await repo.findUsersAffectedByShop(SHOP_A)
    expect(rows[0].lat).toBe(12.97)
    expect(rows[0].lng).toBe(77.59)
    expect(typeof rows[0].lat).toBe('number')
  })

  it('joins users with their default address and filters by target shop pincode/radius', async () => {
    query.mockResolvedValue({ rows: [] })

    await repo.findUsersAffectedByShop(SHOP_A)

    const text = normalize(query.mock.calls[0][0])
    expect(text).toContain('JOIN addresses addr ON addr.user_id = u.id')
    expect(text).toContain('addr.is_default = true')
    expect(text).toContain('addr.pincode = ANY(t.serviceable_pincodes)')
    // Haversine + radius filter
    expect(text).toMatch(/6371 \* acos/)
    expect(text).toContain('<= t.delivery_radius_km::float8')
    // Radius branch must never apply to a pincode_only shop
    expect(text).toContain('NOT t.pincode_only')
    expect(text).toContain('t.pincode_only')
  })
})

// ═══════════════════════════════════════════════════════════
// isServiceable() — hard-block gate for address save / order placement
// ═══════════════════════════════════════════════════════════
describe('AllocationRepository.isServiceable()', () => {
  let repo

  beforeEach(() => {
    vi.clearAllMocks()
    repo = new AllocationRepository()
  })

  it('checks pincode membership OR haversine-within-radius, scoped to no shop by default', async () => {
    query.mockResolvedValue({ rows: [{ serviceable: true }] })

    const result = await repo.isServiceable({
      pincode: '560001',
      lat: 12.97,
      lng: 77.59,
    })

    expect(result).toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)

    expect(text).toContain('SELECT EXISTS')
    expect(text).toContain('$2 = ANY(s.serviceable_pincodes)')
    expect(text).toMatch(/6371 \* acos/)
    expect(text).toContain('<= s.delivery_radius_km::float8')
    expect(text).toContain('s.is_active = true')
    expect(text).toContain('s.deleted_at IS NULL')
    // shopId not passed — first param is null, no shop-scoping applied beyond it
    expect(params).toEqual([null, '560001', 12.97, 77.59, true])
  })

  it('gates the radius branch with NOT s.pincode_only — a pincode_only shop is never matched by distance', async () => {
    query.mockResolvedValue({ rows: [{ serviceable: true }] })

    await repo.isServiceable({ pincode: '560001', lat: 12.97, lng: 77.59 })

    const text = normalize(query.mock.calls[0][0])
    expect(text).toContain('$5::boolean AND NOT s.pincode_only AND')
  })

  it('scopes to one shop when shopId is given', async () => {
    query.mockResolvedValue({ rows: [{ serviceable: false }] })

    const result = await repo.isServiceable({
      shopId: SHOP_A,
      pincode: '999999',
      lat: 1,
      lng: 2,
    })

    expect(result).toBe(false)
    const [sql, params] = query.mock.calls[0]
    const text = normalize(sql)
    expect(text).toContain('$1::uuid IS NULL OR s.id = $1')
    expect(params[0]).toBe(SHOP_A)
  })

  it('falls back to pincode-only matching when coordinates are missing (no NaN reaches SQL)', async () => {
    query.mockResolvedValue({ rows: [{ serviceable: true }] })

    await repo.isServiceable({ pincode: '560001' })

    const [, params] = query.mock.calls[0]
    // lat/lng params are null, hasCoords flag is false — the radius branch
    // is short-circuited in SQL via the $5::boolean guard rather than ever
    // evaluating acos() with non-finite input.
    expect(params).toEqual([null, '560001', null, null, false])
  })

  it('returns false (not throws) when the query yields no row', async () => {
    query.mockResolvedValue({ rows: [] })

    const result = await repo.isServiceable({ pincode: '560001', lat: 1, lng: 2 })

    expect(result).toBe(false)
  })
})
