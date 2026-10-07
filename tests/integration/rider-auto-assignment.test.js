// Task 23.5 — Rider auto-assignment uses order's shop coordinates
// Regression test for the global app_settings bug: handleAutoAssign must
// read pickup_lat/pickup_lng from the order's shop row, NOT from app_settings.
// Shop without lat/lng → MANUAL_REQUIRED + audit event emitted.
//
// Requirements: 12.1, 12.2, 12.3
// Design: §7 (Allocation Pipeline)

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing the SUT ──────────────

// Use vi.hoisted so references are available inside vi.mock factories
const { mockQuery, mockClient, mockIo, mockAuditEmit } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockClient: { query: vi.fn(), release: vi.fn() },
  mockIo: { to: vi.fn().mockReturnThis(), emit: vi.fn() },
  mockAuditEmit: vi.fn(),
}))

vi.mock('../../src/utils/pushNotification.js', () => ({
  sendPush: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/utils/sms.js', () => ({
  sendSmsOtp: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../src/config/database.js', () => ({
  query: (...args) => mockQuery(...args),
  getClient: vi.fn(() => mockClient),
}))

vi.mock('../../src/config/redis.js', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('../../src/config/bullmq.js', () => ({
  orderQueue: { add: vi.fn(), getJobs: vi.fn().mockResolvedValue([]) },
  notificationQueue: { add: vi.fn() },
}))

vi.mock('../../src/plugins/socketio.plugin.js', () => ({
  getSocketIo: () => mockIo,
}))

vi.mock('../../src/plugins/socket-emitter.js', () => ({
  getSocketEmitter: () => mockIo,
}))

vi.mock('../../src/utils/audit-log.js', () => ({
  emit: (...args) => mockAuditEmit(...args),
}))

vi.mock('../../src/utils/cache.js', () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
  cacheDeletePattern: vi.fn(),
}))

vi.mock('../../src/modules/themes/theme-cache.js', () => ({
  ACTIVE_THEME_CACHE_KEY: 'bakaloo:active_theme',
  LEGACY_TAB_CACHE_KEY: 'bakaloo:legacy_tab',
}))

// ─── Import SUT after mocks ──────────────────────────────────────────

import { processOrderJob } from '../../src/workers/processors.js'

// ─── Helpers ─────────────────────────────────────────────────────────

const SHOP_ID_WITH_COORDS = 'shop-aaa-111'
const SHOP_ID_WITHOUT_COORDS = 'shop-bbb-222'
const ORDER_ID = 'order-001'
const RIDER_ID = 'rider-001'

function makeOrderRow(shopId, overrides = {}) {
  return {
    id: ORDER_ID,
    order_number: 'ORD-1001',
    status: 'CONFIRMED',
    rider_id: null,
    total_amount: 500,
    payment_method: 'ONLINE',
    delivery_fee: 30,
    shop_id: shopId,
    items: JSON.stringify([{ name: 'Milk', qty: 2, price: 50 }]),
    delivery_address: JSON.stringify({
      lat: 12.97,
      lng: 77.59,
      address: '123 Main St',
    }),
    created_at: new Date().toISOString(),
    customer_name: 'Test User',
    customer_phone: '+919999999999',
    ...overrides,
  }
}

function makeShopRow(shopId, coords = {}) {
  return {
    id: shopId,
    name: 'Test Shop',
    address: '456 Shop St',
    phone: '+918888888888',
    pickup_lat: 'pickup_lat' in coords ? coords.pickup_lat : null,
    pickup_lng: 'pickup_lng' in coords ? coords.pickup_lng : null,
  }
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Task 23.5 — Rider auto-assignment uses shop coordinates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks() resets call history but NOT queued
    // mockResolvedValueOnce() responses — a test that mocks more
    // calls than the code under test actually makes (e.g. because a
    // candidate gets filtered out before reaching that call) leaks
    // its leftover queued responses into the next test otherwise.
    mockQuery.mockReset()
    mockClient.query.mockReset()
    mockClient.release.mockReset()
  })

  describe('Shop WITH valid pickup_lat/pickup_lng', () => {
    it('uses shop coordinates (not app_settings) for distance calculation', async () => {
      const shopLat = 12.95
      const shopLng = 77.57

      // 1. Order query
      mockQuery
        .mockResolvedValueOnce({
          rows: [makeOrderRow(SHOP_ID_WITH_COORDS)],
        })
        // 2. Shop info query (getShopInfoForOrder)
        .mockResolvedValueOnce({
          rows: [makeShopRow(SHOP_ID_WITH_COORDS, { pickup_lat: shopLat, pickup_lng: shopLng })],
        })
        // 3. Candidate riders query
        .mockResolvedValueOnce({
          rows: [{
            user_id: RIDER_ID,
            current_lat: 12.98,
            current_lng: 77.60,
            last_active_at: new Date().toISOString(),
            location_updated_at: new Date().toISOString(),
          }],
        })
        // 4. FCM tokens for push notification
        .mockResolvedValueOnce({ rows: [] })

      // Transaction client mocks
      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({
          // SELECT FOR UPDATE on order
          rows: [{ id: ORDER_ID, status: 'CONFIRMED', rider_id: null }],
        })
        .mockResolvedValueOnce({ rows: [] }) // existing assignments
        .mockResolvedValueOnce({
          // INSERT delivery_assignment
          rows: [{
            id: 'assign-001',
            order_id: ORDER_ID,
            rider_id: RIDER_ID,
            status: 'ASSIGNED',
            assigned_at: new Date().toISOString(),
            earnings: 25,
            distance_km: 1.5,
          }],
        })
        .mockResolvedValueOnce(undefined) // COMMIT

      const result = await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'TEST' },
      })

      expect(result.assigned).toBe(true)
      expect(result.offers).toHaveLength(1)
      expect(result.offers[0].riderId).toBe(RIDER_ID)

      // Verify shop query was called with the order's shop_id
      const shopQuery = mockQuery.mock.calls.find(
        (call) => call[0].includes('FROM shops') && call[1]?.[0] === SHOP_ID_WITH_COORDS
      )
      expect(shopQuery).toBeDefined()

      // Verify NO query to app_settings for store_lat/store_lng
      const settingsQuery = mockQuery.mock.calls.find(
        (call) => call[0].includes('app_settings')
      )
      expect(settingsQuery).toBeUndefined()
    })

    it('sorts riders by distance from shop coordinates (nearest first)', async () => {
      const shopLat = 12.95
      const shopLng = 77.57

      const nearRider = {
        user_id: 'rider-near',
        current_lat: 12.951,
        current_lng: 77.571,
        last_active_at: new Date().toISOString(),
        location_updated_at: new Date().toISOString(),
      }
      const farRider = {
        user_id: 'rider-far',
        current_lat: 13.10,
        current_lng: 77.80,
        last_active_at: new Date().toISOString(),
        location_updated_at: new Date().toISOString(),
      }

      mockQuery
        .mockResolvedValueOnce({ rows: [makeOrderRow(SHOP_ID_WITH_COORDS)] })
        .mockResolvedValueOnce({
          rows: [makeShopRow(SHOP_ID_WITH_COORDS, { pickup_lat: shopLat, pickup_lng: shopLng })],
        })
        .mockResolvedValueOnce({ rows: [farRider, nearRider] })
        .mockResolvedValueOnce({ rows: [] }) // FCM tokens rider-near
        .mockResolvedValueOnce({ rows: [] }) // FCM tokens rider-far

      mockClient.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: ORDER_ID, status: 'CONFIRMED', rider_id: null }] })
        .mockResolvedValueOnce({ rows: [] }) // existing assignments
        .mockResolvedValueOnce({
          rows: [{
            id: 'assign-near', order_id: ORDER_ID, rider_id: 'rider-near',
            status: 'ASSIGNED', assigned_at: new Date().toISOString(), earnings: 25, distance_km: 0.2,
          }],
        })
        .mockResolvedValueOnce({
          rows: [{
            id: 'assign-far', order_id: ORDER_ID, rider_id: 'rider-far',
            status: 'ASSIGNED', assigned_at: new Date().toISOString(), earnings: 25, distance_km: 20,
          }],
        })
        .mockResolvedValueOnce(undefined) // COMMIT

      const result = await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'TEST' },
      })

      expect(result.assigned).toBe(true)
      expect(result.offers.length).toBeGreaterThanOrEqual(1)
      // First offer should be the nearest rider
      expect(result.offers[0].riderId).toBe('rider-near')
    })

    it('excludes online riders far outside any realistic delivery range, even when they are the only candidate', async () => {
      // Regression: a rider in Surat, Gujarat was being offered a
      // pickup from a Thakurnagar, West Bengal store ~1650km away,
      // because auto-assign offered the order to "nearest of all
      // online riders" with no maximum-distance cutoff at all.
      const shopLat = 22.92444 // Thakurnagar, West Bengal
      const shopLng = 88.77778
      const farAwayRider = {
        user_id: 'rider-far-away',
        current_lat: 21.1959, // Mota Varachha, Surat, Gujarat
        current_lng: 72.8302,
        last_active_at: new Date().toISOString(),
        location_updated_at: new Date().toISOString(),
      }

      mockQuery
        .mockResolvedValueOnce({ rows: [makeOrderRow(SHOP_ID_WITH_COORDS)] })
        .mockResolvedValueOnce({
          rows: [makeShopRow(SHOP_ID_WITH_COORDS, { pickup_lat: shopLat, pickup_lng: shopLng })],
        })
        .mockResolvedValueOnce({ rows: [farAwayRider] })

      const result = await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'TEST' },
      })

      expect(result.assigned).toBe(false)
      expect(result.reason).toBe('NO_RIDERS_IN_RANGE')
      // No assignment INSERT should have been attempted for the
      // out-of-range rider.
      expect(mockClient.query).not.toHaveBeenCalled()
    })
  })

  describe('Shop WITHOUT lat/lng → MANUAL_REQUIRED + audit', () => {
    it('returns SHOP_COORDS_MISSING and sets auto_assignment_status to MANUAL_REQUIRED', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeOrderRow(SHOP_ID_WITHOUT_COORDS)] })
        // Shop not found in DB → getShopInfoForOrder returns null
        .mockResolvedValueOnce({ rows: [] })
        // UPDATE orders SET auto_assignment_status = 'MANUAL_REQUIRED'
        .mockResolvedValueOnce({ rows: [] })

      const result = await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'TEST' },
      })

      expect(result.assigned).toBe(false)
      expect(result.reason).toBe('SHOP_COORDS_MISSING')

      // Verify the order was marked MANUAL_REQUIRED
      const updateCall = mockQuery.mock.calls.find(
        (call) => call[0].includes('MANUAL_REQUIRED')
      )
      expect(updateCall).toBeDefined()
      expect(updateCall[1]).toContain(ORDER_ID)
    })

    it('emits audit event for auto_assignment_failed with SHOP_COORDS_MISSING', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeOrderRow(SHOP_ID_WITHOUT_COORDS)] })
        // Shop not found → triggers SHOP_COORDS_MISSING
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })

      await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'SYSTEM' },
      })

      expect(mockAuditEmit).toHaveBeenCalledWith(
        'auto_assignment_failed',
        expect.objectContaining({
          target_type: 'order',
          target_id: ORDER_ID,
          after: expect.objectContaining({
            reason: 'SHOP_COORDS_MISSING',
            source: 'SYSTEM',
          }),
        })
      )
    })

    it('emits Socket.IO event to hq:global channel on missing coords', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeOrderRow(SHOP_ID_WITHOUT_COORDS)] })
        // Shop not found → triggers SHOP_COORDS_MISSING
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })

      await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'TEST' },
      })

      expect(mockIo.to).toHaveBeenCalledWith('hq:global')
      expect(mockIo.emit).toHaveBeenCalledWith(
        'order.auto_assignment_failed',
        expect.objectContaining({
          orderId: ORDER_ID,
          shopId: SHOP_ID_WITHOUT_COORDS,
          reason: 'SHOP_COORDS_MISSING',
        })
      )
    })

    it('handles shop not found in DB (null row) as SHOP_COORDS_MISSING', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeOrderRow('shop-nonexistent')] })
        // Shop query returns empty
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })

      const result = await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'TEST' },
      })

      expect(result.assigned).toBe(false)
      expect(result.reason).toBe('SHOP_COORDS_MISSING')
    })

    it('handles shop with only pickup_lat (missing pickup_lng) as SHOP_COORDS_MISSING', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [makeOrderRow(SHOP_ID_WITHOUT_COORDS)] })
        .mockResolvedValueOnce({
          rows: [makeShopRow(SHOP_ID_WITHOUT_COORDS, { pickup_lat: 12.95, pickup_lng: 'not_set' })],
        })
        .mockResolvedValueOnce({ rows: [] })

      const result = await processOrderJob({
        data: { type: 'auto-assign', orderId: ORDER_ID, source: 'TEST' },
      })

      expect(result.assigned).toBe(false)
      expect(result.reason).toBe('SHOP_COORDS_MISSING')
    })
  })
})
