/**
 * VendorProcurementRepository — Home overview data (2026-09-29)
 *
 * The vendor app's Home screen showed hardcoded "—" for "This Month Value"
 * and "Rating", had no earnings chart and no top-selling-products list, and
 * request/quote item rows never showed the product's real catalog image.
 * Covers the three repository additions that close those gaps:
 *   - findRequestItems: LEFT JOIN products for a real thumbnail_url
 *   - getVendorMonthlyTrend: zero-filled last-N-months revenue for the chart
 *   - getVendorTopProducts: best-selling products by confirmed supply value
 * and that getVendorPerformance's aggregate response actually includes both
 * new blocks (additive — every existing field stays exactly as before).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] })) }))
vi.mock('../../../src/config/database.js', () => ({ query: databaseMock.query, getClient: vi.fn() }))

import { VendorProcurementRepository } from '../../../src/modules/vendor-procurement/vendor-procurement.repository.js'

beforeEach(() => {
  databaseMock.query.mockReset()
})

describe('findRequestItems — product image join', () => {
  it('LEFT JOINs products for a real thumbnail_url, never dropping a legacy item with no product_id', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = new VendorProcurementRepository()

    await repo.findRequestItems('req-1')

    expect(databaseMock.query).toHaveBeenCalledTimes(1)
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('LEFT JOIN products p ON p.id = i.product_id')
    expect(sql).toContain('p.thumbnail_url AS product_image_url')
    // Still an inner JOIN on categories — unrelated to this change, and a
    // request item always has a real category.
    expect(sql).toContain('JOIN categories c ON c.id = i.category_id')
    expect(params).toEqual(['req-1'])
  })

  it('surfaces product_image_url on the returned row for a real matched product', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [
        {
          id: 'item-1',
          item_name: 'Salmon Steak (250 g)',
          category_name: 'Fish & Seafood',
          product_image_url: 'https://res.cloudinary.com/h9sgzkie/image/upload/salmon.jpg',
        },
      ],
    })
    const repo = new VendorProcurementRepository()

    const rows = await repo.findRequestItems('req-1')

    expect(rows[0].product_image_url).toBe('https://res.cloudinary.com/h9sgzkie/image/upload/salmon.jpg')
  })
})

describe('getVendorMonthlyTrend', () => {
  it('zero-fills the last 6 months via generate_series, LEFT JOINing only RECEIVED/CLOSED supply orders for this vendor', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = new VendorProcurementRepository()

    await repo.getVendorMonthlyTrend('vendor-1')

    expect(databaseMock.query).toHaveBeenCalledTimes(1)
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('generate_series(')
    expect(sql).toContain("interval '1 month'")
    expect(sql).toContain('LEFT JOIN procurement_supply_orders so')
    expect(sql).toContain('so.vendor_id = $1')
    expect(sql).toContain("so.status IN ('RECEIVED', 'CLOSED')")
    expect(sql).toContain('so.deleted_at IS NULL')
    expect(sql).toContain('GROUP BY month_start')
    expect(sql).toContain('ORDER BY month_start')
    expect(params).toEqual(['vendor-1', 6])
  })

  it('honours a custom months count', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = new VendorProcurementRepository()

    await repo.getVendorMonthlyTrend('vendor-1', 12)

    expect(databaseMock.query.mock.calls[0][1]).toEqual(['vendor-1', 12])
  })

  it('maps each row to {month, label, value} in the order the DB returns it (oldest first)', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [
        { month: '2026-04', label: 'Apr', value: '0' },
        { month: '2026-05', label: 'May', value: '1200.50' },
      ],
    })
    const repo = new VendorProcurementRepository()

    const trend = await repo.getVendorMonthlyTrend('vendor-1')

    expect(trend).toEqual([
      { month: '2026-04', label: 'Apr', value: '0' },
      { month: '2026-05', label: 'May', value: '1200.50' },
    ])
  })
})

describe('getVendorTopProducts', () => {
  it('aggregates confirmed supply value by product, LEFT JOINing products for name/image fallback', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = new VendorProcurementRepository()

    await repo.getVendorTopProducts('vendor-1')

    expect(databaseMock.query).toHaveBeenCalledTimes(1)
    const [sql, params] = databaseMock.query.mock.calls[0]
    expect(sql).toContain('FROM procurement_supply_order_items soi')
    expect(sql).toContain('JOIN procurement_supply_orders so ON so.id = soi.supply_order_id')
    expect(sql).toContain('LEFT JOIN products p ON p.id = soi.product_id')
    expect(sql).toContain('so.vendor_id = $1')
    expect(sql).toContain("so.status IN ('RECEIVED', 'CLOSED')")
    expect(sql).toContain('so.deleted_at IS NULL')
    // Groups by product_id AND the coalesced name — a legacy item with a
    // null product_id must never silently merge with a different legacy
    // item that happens to share the same null.
    expect(sql).toContain('GROUP BY soi.product_id, COALESCE(p.name, soi.item_name), p.thumbnail_url')
    expect(sql).toContain('ORDER BY value DESC')
    expect(sql).toContain('LIMIT $2')
    expect(params).toEqual(['vendor-1', 5])
  })

  it('honours a custom limit', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const repo = new VendorProcurementRepository()

    await repo.getVendorTopProducts('vendor-1', 10)

    expect(databaseMock.query.mock.calls[0][1]).toEqual(['vendor-1', 10])
  })

  it('maps rows to the {product_id, name, image_url, quantity, unit, value} shape the app expects', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [
        {
          product_id: 'p1',
          name: 'Salmon Steak (250 g)',
          image_url: 'https://res.cloudinary.com/h9sgzkie/image/upload/salmon.jpg',
          quantity: '42.50',
          unit: 'KG',
          value: '18900.00',
        },
      ],
    })
    const repo = new VendorProcurementRepository()

    const products = await repo.getVendorTopProducts('vendor-1')

    expect(products).toEqual([
      {
        product_id: 'p1',
        name: 'Salmon Steak (250 g)',
        image_url: 'https://res.cloudinary.com/h9sgzkie/image/upload/salmon.jpg',
        quantity: '42.50',
        unit: 'KG',
        value: '18900.00',
      },
    ])
  })

  it('a legacy item with no product_id still surfaces under its own item_name, image_url null', async () => {
    databaseMock.query.mockResolvedValue({
      rows: [{ product_id: null, name: 'Legacy Item', image_url: null, quantity: '5', unit: 'KG', value: '500' }],
    })
    const repo = new VendorProcurementRepository()

    const products = await repo.getVendorTopProducts('vendor-1')

    expect(products[0].product_id).toBeNull()
    expect(products[0].name).toBe('Legacy Item')
    expect(products[0].image_url).toBeNull()
  })
})

describe('findVendorStatus — vendor name', () => {
  // getVendorPerformance builds {vendor: {id, name, status}} from this same
  // row — without `name` selected here, the vendor app's Performance screen
  // always fell back to its generic "Your store" placeholder.
  it('selects name alongside id/status/is_active', async () => {
    databaseMock.query.mockResolvedValue({ rows: [{ id: 'v1', name: 'Kolkata Fresh Meats', status: 'ACTIVE', is_active: true }] })
    const repo = new VendorProcurementRepository()

    const vendor = await repo.findVendorStatus('v1')

    const sql = databaseMock.query.mock.calls[0][0]
    expect(sql).toContain('SELECT id, name, status, is_active FROM vendors')
    expect(vendor.name).toBe('Kolkata Fresh Meats')
  })
})

describe('getVendorPerformance — aggregate response', () => {
  it('includes monthly_trend and top_products alongside every existing field, additive only', async () => {
    databaseMock.query.mockImplementation(async (sql) => {
      if (sql.includes('COUNT(*)::int AS total_supplies')) {
        return {
          rows: [
            {
              total_supplies: 10,
              completed_supplies: 8,
              active_supplies: 2,
              on_time_supplies: 7,
              deliverable_supplies: 8,
              total_value: '50000',
              month_value: '12000',
              month_quantity: '80',
            },
          ],
        }
      }
      if (sql.includes('AVG(rating_overall)')) {
        return { rows: [{ avg_rating: '4.5', review_count: 6, issue_count: 1 }] }
      }
      if (sql.includes('generate_series(')) {
        return { rows: [{ month: '2026-09', label: 'Sep', value: '12000' }] }
      }
      if (sql.includes('procurement_supply_order_items soi')) {
        return { rows: [{ product_id: 'p1', name: 'Salmon Steak', image_url: null, quantity: '10', unit: 'KG', value: '4500' }] }
      }
      return { rows: [] }
    })
    const repo = new VendorProcurementRepository()

    const performance = await repo.getVendorPerformance('vendor-1')

    // Every field the vendor app / dashboard already read is unchanged.
    expect(performance.total_supplies).toBe(10)
    expect(performance.completed_supplies).toBe(8)
    expect(performance.on_time_rate).toBeCloseTo(87.5, 1)
    expect(performance.month_value).toBe('12000')
    expect(performance.avg_rating).toBe('4.5')
    expect(performance.review_count).toBe(6)
    // New, additive fields.
    expect(performance.monthly_trend).toEqual([{ month: '2026-09', label: 'Sep', value: '12000' }])
    expect(performance.top_products).toEqual([
      { product_id: 'p1', name: 'Salmon Steak', image_url: null, quantity: '10', unit: 'KG', value: '4500' },
    ])
  })
})
