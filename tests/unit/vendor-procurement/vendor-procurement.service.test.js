/**
 * Vendor Procurement Service tests — request core (Big Phase 3)
 *
 * Covers the request lifecycle state machine, store-scope guard, publish-time
 * eligible-vendor targeting (blueprint §5, §21) and fixed-offer/RFQ item
 * normalization. The database layer is mocked per repo test convention.
 *
 * Database-level constraint invariants live in
 * tests/integration/vendor-procurement-schema.invariants.test.js.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// ─── Mock external dependencies BEFORE importing the service ────────────────

const databaseMock = vi.hoisted(() => {
  const fakeClient = {
    query: vi.fn(async (sql) => {
      if (typeof sql === 'string' && /INSERT INTO audit_logs/i.test(sql)) return { rows: [] }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return {
    query: vi.fn(async () => ({ rows: [] })),
    getClient: vi.fn(async () => fakeClient),
    fakeClient,
  }
})

vi.mock('../../../src/config/database.js', () => ({
  query: databaseMock.query,
  getClient: databaseMock.getClient,
  pool: { query: databaseMock.query },
}))

vi.mock('../../../src/utils/audit-log.js', () => ({
  emit: vi.fn(),
  emitInTx: vi.fn(async () => true),
}))

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { VendorProcurementService, REQUEST_TRANSITIONS } from '../../../src/modules/vendor-procurement/vendor-procurement.service.js'
import { evaluateVendorEligibility, resolveEligibleVendors } from '../../../src/modules/vendor-procurement/vendor-eligibility.js'

// ─── Helpers ────────────────────────────────────────────────────────────────

const HQ = { scopedShopId: null }
const KOLKATA = { scopedShopId: 'shop-1' }

function makeService(repoOverrides = {}) {
  const repo = {
    insertRequest: vi.fn(async (data) => ({ id: 'req-1', status: 'DRAFT', ...data })),
    insertRequestItem: vi.fn(async (_requestId, item) => ({ id: `item-${Math.random()}`, ...item })),
    updateRequestDraft: vi.fn(async (id, patch) => ({ id, status: 'DRAFT', ...patch })),
    replaceRequestItems: vi.fn(async (id, items) => items.map((item, i) => ({ id: `item-${i}`, ...item }))),
    findRequestById: vi.fn(async () => null),
    findRequestItems: vi.fn(async () => []),
    listRequests: vi.fn(async () => ({ requests: [], total: 0, page: 1, limit: 20 })),
    listRecipients: vi.fn(async () => []),
    updateRequestStatus: vi.fn(async (_id, status, extra) => ({ id: 'req-1', status, ...extra })),
    insertRecipients: vi.fn(async (_id, recipients) =>
      recipients.map((r, i) => ({ id: `rec-${i}`, request_id: 'req-1', vendor_id: r.vendorId, status: 'NEW', eligibility: r.eligibility }))
    ),
    expireUnrespondedRecipients: vi.fn(async () => [{ id: 'rec-0' }]),
    setRecipientStatus: vi.fn(async (_id, status) => ({ id: 'rec-1', status })),
    findEligibleVendorCandidates: vi.fn(async () => []),
    ...repoOverrides,
  }
  return { service: new VendorProcurementService(repo), repo }
}

const FIXED_ITEM = {
  category_id: '11111111-1111-1111-1111-111111111111',
  product_id: '99999999-9999-9999-9999-999999999999',
  item_name: 'Chicken',
  requested_quantity: 20,
  unit: 'KG',
  fixed_unit_price: 250,
}

const RFQ_ITEM = {
  category_id: '11111111-1111-1111-1111-111111111111',
  product_id: '88888888-8888-8888-8888-888888888888',
  item_name: 'Mutton',
  requested_quantity: 20,
  unit: 'KG',
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─── State machine ──────────────────────────────────────────────────────────

describe('request lifecycle state machine', () => {
  it('allows draft → published and published → awarded/cancelled/expired', () => {
    expect(REQUEST_TRANSITIONS.DRAFT).toContain('PUBLISHED')
    expect(REQUEST_TRANSITIONS.PUBLISHED).toEqual(expect.arrayContaining(['AWARDED', 'CANCELLED', 'EXPIRED']))
    expect(REQUEST_TRANSITIONS.AWARDED).toContain('IN_FULFILMENT')
    expect(REQUEST_TRANSITIONS.IN_FULFILMENT).toContain('COMPLETED')
  })

  it('rejects invalid transitions such as draft → completed', () => {
    const { service } = makeService()
    expect(() => service.validateStateTransition('DRAFT', 'COMPLETED')).toThrowError(
      expect.objectContaining({ code: 'INVALID_STATE_TRANSITION', statusCode: 400 })
    )
    expect(() => service.validateStateTransition('CANCELLED', 'PUBLISHED')).toThrow()
    expect(() => service.validateStateTransition('EXPIRED', 'PUBLISHED')).toThrow()
  })
})

// ─── Store scoping ──────────────────────────────────────────────────────────

describe('store scope guard', () => {
  it('rejects store staff acting on another store’s request', () => {
    const { service } = makeService()
    expect(() => service.assertShopAccess('shop-1', 'shop-2')).toThrowError(
      expect.objectContaining({ code: 'CROSS_SHOP_ACCESS_DENIED', statusCode: 403 })
    )
  })

  it('allows HQ (no shop scope) and matching shop scopes', () => {
    const { service } = makeService()
    expect(() => service.assertShopAccess(null, 'shop-2')).not.toThrow()
    expect(() => service.assertShopAccess('shop-1', 'shop-1')).not.toThrow()
  })
})

// ─── Draft creation ─────────────────────────────────────────────────────────

describe('createDraft', () => {
  it('computes fixed line totals and offer total for FIXED_OFFER mode', async () => {
    const { service, repo } = makeService()

    const result = await service.createDraft('actor-1', {
      shop_id: 'shop-1',
      mode: 'FIXED_OFFER',
      title: 'Weekly chicken supply',
      items: [FIXED_ITEM, { ...FIXED_ITEM, item_name: 'Fish', requested_quantity: 10, fixed_unit_price: 300 }],
    })

    expect(result.offer_total).toBe(8000)
    expect(result.items[0].fixed_line_total).toBe(5000)
    expect(result.items[1].fixed_line_total).toBe(3000)
    expect(repo.insertRequest).toHaveBeenCalledTimes(1)
    const inserted = repo.insertRequest.mock.calls[0][0]
    expect(inserted.request_number).toMatch(/^PRQ-\d{8}-[0-9A-F]{4}$/)
    expect(inserted.offer_total).toBe(8000)
  })

  it('strips fixed pricing and leaves offer total null for RFQ mode', async () => {
    const { service, repo } = makeService()

    const result = await service.createDraft('actor-1', {
      shop_id: 'shop-1',
      mode: 'RFQ',
      title: 'Weekly meat supply',
      items: [{ ...RFQ_ITEM, fixed_unit_price: 999 }],
    })

    expect(result.offer_total).toBeNull()
    expect(result.items[0].fixed_unit_price).toBeNull()
    expect(result.items[0].fixed_line_total).toBeNull()
    expect(repo.insertRequest.mock.calls[0][0].offer_total).toBeNull()
  })

  it('rejects store staff creating a requirement for another store', async () => {
    const { service } = makeService()

    await expect(
      service.createDraft('actor-1', { shop_id: 'shop-2', mode: 'RFQ', title: 'x', items: [RFQ_ITEM] }, KOLKATA)
    ).rejects.toMatchObject({ code: 'CROSS_SHOP_ACCESS_DENIED' })
  })

  it('normalizes unknown units to KG and requires positive quantities', async () => {
    const { service } = makeService()

    const items = service.normalizeItems('RFQ', [{ ...RFQ_ITEM, unit: 'BAG' }])
    expect(items[0].unit).toBe('KG')

    expect(() =>
      service.assertItemsValid([{ ...RFQ_ITEM, requested_quantity: 0 }])
    ).toThrowError(expect.objectContaining({ code: 'PROCUREMENT_ITEM_INVALID' }))
  })
})

// ── Draft editing ───────────────────────────────────────────────────────────

describe('updateDraft', () => {
  it('rejects editing a published request', async () => {
    const { service, repo } = makeService({
      findRequestById: vi.fn(async () => ({ id: 'req-1', status: 'PUBLISHED', shop_id: 'shop-1', mode: 'RFQ' })),
    })

    await expect(service.updateDraft('req-1', 'actor-1', { title: 'new' }, HQ)).rejects.toMatchObject({
      code: 'PROCUREMENT_REQUEST_NOT_EDITABLE',
      statusCode: 409,
    })
    expect(repo.updateRequestDraft).not.toHaveBeenCalled()
  })

  it('recomputes the offer total when items change', async () => {
    const { service, repo } = makeService({
      findRequestById: vi.fn(async () => ({ id: 'req-1', status: 'DRAFT', shop_id: 'shop-1', mode: 'FIXED_OFFER' })),
    })

    await service.updateDraft('req-1', 'actor-1', { items: [FIXED_ITEM] }, HQ)

    const patch = repo.updateRequestDraft.mock.calls[0][1]
    expect(patch.offer_total).toBe(5000)
    expect(repo.replaceRequestItems).toHaveBeenCalledTimes(1)
  })
})

// ─── Publish ────────────────────────────────────────────────────────────────

const KOLKATA_SHOP = {
  shop_pincode: '700001',
  shop_serviceable_pincodes: ['700001'],
  shop_city: 'Kolkata',
}

function candidate(overrides = {}) {
  return {
    id: 'vendor-x',
    name: 'Vendor X',
    status: 'ACTIVE',
    is_active: true,
    has_active_user: true,
    service_pincodes: ['700001'],
    profile_pincode: '700001',
    profile_city: 'Kolkata',
    ...overrides,
  }
}

function publishableRequest(overrides = {}) {
  return {
    id: 'req-1',
    request_number: 'PRQ-TEST-0001',
    status: 'DRAFT',
    shop_id: 'shop-1',
    mode: 'RFQ',
    response_deadline: new Date(Date.now() + 3600_000).toISOString(),
    required_delivery_at: new Date(Date.now() + 7200_000).toISOString(),
    ...KOLKATA_SHOP,
    ...overrides,
  }
}

describe('publishRequest targeting', () => {
  it('persists recipients only for eligible vendors (Kolkata in, Delhi out, suspended out)', async () => {
    const kolkata = candidate({ id: 'vendor-kolkata' })
    const delhi = candidate({ id: 'vendor-delhi', service_pincodes: ['110001'], profile_pincode: '110001', profile_city: 'Delhi' })
    const suspended = candidate({ id: 'vendor-suspended', status: 'SUSPENDED' })
    const noUser = candidate({ id: 'vendor-nouser', has_active_user: false })

    const { service, repo } = makeService({
      findRequestById: vi.fn(async () => publishableRequest()),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
      findEligibleVendorCandidates: vi.fn(async () => [kolkata, delhi, suspended, noUser]),
    })

    const result = await service.publishRequest('req-1', 'actor-1', HQ)

    expect(result.recipients).toHaveLength(1)
    expect(result.recipients[0].vendor_id).toBe('vendor-kolkata')
    expect(result.recipients[0].eligibility.matched_pincodes).toContain('700001')
    expect(result.rejected_count).toBe(3)
    expect(repo.updateRequestStatus).toHaveBeenCalledWith(
      'req-1',
      'PUBLISHED',
      expect.objectContaining({ published_at: expect.any(String) })
    )
  })

  it('keeps vendors without declared service areas eligible but records the gap', async () => {
    const unknownArea = candidate({ id: 'vendor-unknown', service_pincodes: undefined, profile_pincode: null, profile_city: null })

    const { service } = makeService({
      findRequestById: vi.fn(async () => publishableRequest()),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
      findEligibleVendorCandidates: vi.fn(async () => [unknownArea]),
    })

    const result = await service.publishRequest('req-1', 'actor-1', HQ)
    expect(result.recipients).toHaveLength(1)
    expect(result.recipients[0].eligibility.service_pincodes_unavailable).toBe(true)
  })

  it('fails with PROCUREMENT_NO_ELIGIBLE_VENDORS when no vendor matches', async () => {
    const { service } = makeService({
      findRequestById: vi.fn(async () => publishableRequest()),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
      findEligibleVendorCandidates: vi.fn(async () => [candidate({ id: 'v-delhi', service_pincodes: ['110001'], profile_city: 'Delhi', profile_pincode: '110001' })]),
    })

    await expect(service.publishRequest('req-1', 'actor-1', HQ)).rejects.toMatchObject({
      code: 'PROCUREMENT_NO_ELIGIBLE_VENDORS',
      statusCode: 409,
    })
  })

  it('enforces publish preconditions: deadline, delivery time, fixed prices', async () => {
    const noDeadline = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ response_deadline: null })),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
    })
    await expect(
      noDeadline.service.publishRequest('req-1', 'actor-1', HQ)
    ).rejects.toMatchObject({ code: 'PROCUREMENT_DEADLINE_REQUIRED' })

    const pastDeadline = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ response_deadline: new Date(Date.now() - 1000).toISOString() })),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
    })
    await expect(pastDeadline.service.publishRequest('req-1', 'actor-1', HQ)).rejects.toMatchObject({
      code: 'PROCUREMENT_DEADLINE_PAST',
    })

    const noDelivery = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ required_delivery_at: null })),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
    })
    await expect(noDelivery.service.publishRequest('req-1', 'actor-1', HQ)).rejects.toMatchObject({
      code: 'PROCUREMENT_DELIVERY_REQUIRED',
    })

    const fixedWithoutPrice = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ mode: 'FIXED_OFFER' })),
      findRequestItems: vi.fn(async () => [{ ...RFQ_ITEM, fixed_unit_price: null }]),
    })
    await expect(fixedWithoutPrice.service.publishRequest('req-1', 'actor-1', HQ)).rejects.toMatchObject({
      code: 'PROCUREMENT_FIXED_PRICE_REQUIRED',
    })
  })

  it('blocks store staff publishing another store’s request', async () => {
    const { service } = makeService({
      findRequestById: vi.fn(async () => publishableRequest()),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
    })

    await expect(service.publishRequest('req-1', 'actor-1', { scopedShopId: 'shop-9' })).rejects.toMatchObject({
      code: 'CROSS_SHOP_ACCESS_DENIED',
    })
  })
})

// ─── Cancel / expire ────────────────────────────────────────────────────────

describe('cancelRequest and expireRequest', () => {
  it('cancels a published request and expires unresponded recipients', async () => {
    const { service, repo } = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ status: 'PUBLISHED' })),
    })

    const result = await service.cancelRequest('req-1', 'actor-1', 'wrong quantities', HQ)

    expect(result.status).toBe('CANCELLED')
    expect(repo.updateRequestStatus).toHaveBeenCalledWith(
      'req-1',
      'CANCELLED',
      expect.objectContaining({ closed_at: expect.any(String), cancel_reason: 'wrong quantities' })
    )
    expect(repo.expireUnrespondedRecipients).toHaveBeenCalledWith('req-1')
  })

  it('rejects cancelling an already completed request', async () => {
    const { service } = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ status: 'COMPLETED' })),
    })

    await expect(service.cancelRequest('req-1', 'actor-1', null, HQ)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
    })
  })

  it('expires a published request and closes unresponded recipients', async () => {
    const { service, repo } = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ status: 'PUBLISHED' })),
    })

    const result = await service.expireRequest('req-1', 'actor-1', HQ)
    expect(result.status).toBe('EXPIRED')
    expect(repo.expireUnrespondedRecipients).toHaveBeenCalledWith('req-1')
  })
})

// ─── Pure eligibility resolver ──────────────────────────────────────────────

describe('vendor-eligibility resolver', () => {
  const shop = { pincode: '700001', serviceable_pincodes: ['700001'], city: 'Kolkata' }
  const request = { mode: 'RFQ' }
  const items = [{ category_id: 'cat-chicken' }]

  it('requires ACTIVE status and an active vendor user', () => {
    expect(evaluateVendorEligibility(candidate(), shop, request, items).eligible).toBe(true)
    expect(evaluateVendorEligibility(candidate({ status: 'SUSPENDED' }), shop, request, items).eligible).toBe(false)
    expect(evaluateVendorEligibility(candidate({ has_active_user: false }), shop, request, items).eligible).toBe(false)
  })

  it('matches categories when the vendor declares them and records overlap', () => {
    const matching = candidate({ categories: ['cat-chicken', 'cat-mutton'] })
    const nonMatching = candidate({ categories: ['cat-fish'] })

    expect(evaluateVendorEligibility(matching, shop, request, items).eligible).toBe(true)
    expect(evaluateVendorEligibility(matching, shop, request, items).eligibility.matched_categories).toEqual(['cat-chicken'])
    expect(evaluateVendorEligibility(nonMatching, shop, request, items).eligible).toBe(false)
  })

  it('matches the store area against declared service pincodes (store-first)', () => {
    const local = candidate()
    const remote = candidate({ service_pincodes: ['110001'], profile_pincode: '110001', profile_city: 'Delhi' })

    expect(evaluateVendorEligibility(local, shop, request, items).eligibility.matched_pincodes).toEqual(['700001'])
    expect(evaluateVendorEligibility(remote, shop, request, items).eligible).toBe(false)
  })

  it('uses profile city as a weak fallback only while service areas are unknown', () => {
    const sameCity = candidate({ service_pincodes: undefined, profile_pincode: null, profile_city: 'Kolkata' })
    const otherCity = candidate({ service_pincodes: undefined, profile_pincode: null, profile_city: 'Delhi' })

    expect(evaluateVendorEligibility(sameCity, shop, request, items).eligible).toBe(true)
    expect(evaluateVendorEligibility(otherCity, shop, request, items).eligible).toBe(false)
  })

  it('splits a candidate list into recipients and rejected with snapshots', () => {
    const { recipients, rejected } = resolveEligibleVendors(
      [candidate({ id: 'v1' }), candidate({ id: 'v2', status: 'DEACTIVATED' })],
      shop,
      request,
      items
    )
    expect(recipients.map((r) => r.vendorId)).toEqual(['v1'])
    expect(recipients[0].eligibility.checks.vendor_status).toBe(true)
    expect(rejected.map((r) => r.vendorId)).toEqual(['v2'])
  })
})

// ─── Fixed offer accept / decline (Big Phase 4) ─────────────────────────────

describe('acceptFixedOffer', () => {
  const fixedRequest = () => ({
    id: 'req-1',
    status: 'PUBLISHED',
    shop_id: 'shop-1',
    mode: 'FIXED_OFFER',
    request_number: 'PRQ-TEST-0001',
    offer_total: 5000,
    response_deadline: new Date(Date.now() + 3600_000).toISOString(),
    required_delivery_at: new Date(Date.now() + 7200_000).toISOString(),
    ...KOLKATA_SHOP,
  })

  function acceptService(repoOverrides = {}) {
    return makeService({
      findVendorStatus: vi.fn(async () => ({ id: 'vendor-1', status: 'ACTIVE', is_active: true })),
      findRequestById: vi.fn(async () => fixedRequest()),
      findRecipientByRequestAndVendor: vi.fn(async () => ({ id: 'rec-1', status: 'NEW' })),
      lockRequestTx: vi.fn(async () => fixedRequest()),
      awardRequestTx: vi.fn(async (_c, _id, vendorId, total) => ({ id: 'req-1', status: 'AWARDED', awarded_vendor_id: vendorId, award_total: total })),
      setRecipientStatus: vi.fn(async () => ({ id: 'rec-1', status: 'AWARDED' })),
      setOtherRecipientsNotSelectedTx: vi.fn(async () => []),
      findRequestItems: vi.fn(async () => [{ id: 'item-1', category_id: 'cat-1', product_id: 'prod-chicken-1', item_name: 'Chicken', requested_quantity: 20, unit: 'KG', fixed_unit_price: 250, fixed_line_total: 5000 }]),
      insertSupplyOrderTx: vi.fn(async () => ({ id: 'supply-1', supply_number: 'SUP-TEST-0001' })),
      insertSupplyOrderItemsTx: vi.fn(async () => []),
      insertSupplyEventTx: vi.fn(async () => ({ id: 'evt-1' })),
      ...repoOverrides,
    })
  }

  it('awards the winner: recipient AWARDED, others NOT_SELECTED, supply order created', async () => {
    const { service, repo } = acceptService()

    const result = await service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')

    expect(result.request.status).toBe('AWARDED')
    expect(result.supply_order.id).toBe('supply-1')
    expect(repo.setOtherRecipientsNotSelectedTx).toHaveBeenCalledWith(expect.anything(), 'req-1', 'rec-1')
    expect(repo.insertSupplyOrderTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      vendor_id: 'vendor-1',
      source_mode: 'FIXED_OFFER',
      award_amount: 5000,
      supply_number: expect.stringMatching(/^SUP-\d{8}-[0-9A-F]{4}$/),
    }))
    const itemsArg = repo.insertSupplyOrderItemsTx.mock.calls[0][2]
    expect(itemsArg[0]).toMatchObject({ agreed_quantity: 20, agreed_unit_price: 250, agreed_line_total: 5000 })
  })

  it('copies the request item’s exact product_id onto the supply order item — the "which SKU" link that must survive award', async () => {
    const { service, repo } = acceptService()

    await service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')

    const itemsArg = repo.insertSupplyOrderItemsTx.mock.calls[0][2]
    expect(itemsArg[0].product_id).toBe('prod-chicken-1')
  })

  it('returns ALREADY_AWARDED when the conditional award loses the race (0 rows)', async () => {
    const { service } = acceptService({
      awardRequestTx: vi.fn(async () => null),
    })

    await expect(service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')).rejects.toMatchObject({
      code: 'ALREADY_AWARDED',
      statusCode: 409,
    })
  })

  it('returns ALREADY_AWARDED when the row lock shows the request already awarded', async () => {
    const { service } = acceptService({
      lockRequestTx: vi.fn(async () => fixedRequest().status = 'AWARDED' && { id: 'req-1', status: 'AWARDED' }),
    })

    await expect(service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')).rejects.toMatchObject({
      code: 'ALREADY_AWARDED',
    })
  })

  it('rejects a suspended vendor before touching the request', async () => {
    const { service, repo } = acceptService({
      findVendorStatus: vi.fn(async () => ({ id: 'vendor-1', status: 'SUSPENDED', is_active: true })),
    })

    await expect(service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')).rejects.toMatchObject({
      code: 'VENDOR_NOT_RESPONDABLE',
    })
    expect(repo.lockRequestTx).not.toHaveBeenCalled()
  })

  it('rejects accepts on RFQ requests and past-deadline offers', async () => {
    const rfq = acceptService({
      findRequestById: vi.fn(async () => fixedRequest().mode = 'RFQ' && { ...fixedRequest(), mode: 'RFQ' }),
    })
    await expect(rfq.service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')).rejects.toMatchObject({
      code: 'PROCUREMENT_NOT_FIXED_OFFER',
    })

    const expired = acceptService({
      findRequestById: vi.fn(async () => ({ ...fixedRequest(), response_deadline: new Date(Date.now() - 1000).toISOString() })),
    })
    await expect(expired.service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')).rejects.toMatchObject({
      code: 'PROCUREMENT_DEADLINE_PASSED',
    })
  })

  it('rejects a vendor that was never targeted', async () => {
    const { service } = acceptService({
      findRecipientByRequestAndVendor: vi.fn(async () => null),
    })

    await expect(service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')).rejects.toMatchObject({
      code: 'PROCUREMENT_REQUEST_NOT_FOUND',
    })
  })
})

describe('declineRequest', () => {
  it('declines an open recipient and audits the decline', async () => {
    const { service, repo } = makeService({
      findVendorStatus: vi.fn(async () => ({ id: 'vendor-1', status: 'ACTIVE', is_active: true })),
      findRequestById: vi.fn(async () => ({ id: 'req-1', status: 'PUBLISHED', mode: 'RFQ' })),
      findRecipientByRequestAndVendor: vi.fn(async () => ({ id: 'rec-1', status: 'VIEWED' })),
      setRecipientStatus: vi.fn(async () => ({ id: 'rec-1', status: 'DECLINED' })),
    })

    const result = await service.declineRequest('req-1', 'vendor-1', 'actor-1')
    expect(result.status).toBe('DECLINED')
    expect(repo.setRecipientStatus).toHaveBeenCalledWith('rec-1', 'DECLINED')
  })

  it('refuses to decline after the recipient already responded', async () => {
    const { service } = makeService({
      findVendorStatus: vi.fn(async () => ({ id: 'vendor-1', status: 'ACTIVE', is_active: true })),
      findRequestById: vi.fn(async () => ({ id: 'req-1', status: 'PUBLISHED', mode: 'RFQ' })),
      findRecipientByRequestAndVendor: vi.fn(async () => ({ id: 'rec-1', status: 'RESPONDED' })),
    })

    await expect(service.declineRequest('req-1', 'vendor-1', 'actor-1')).rejects.toMatchObject({
      code: 'PROCUREMENT_RECIPIENT_CLOSED',
    })
  })
})

// ─── Notification hooks (Big Phase 7) ───────────────────────────────────────

describe('procurement notification hooks', () => {
  function stubNotifier(service) {
    service.notifier = {
      requestPublished: vi.fn(),
      requestClosed: vi.fn(),
      offerAwarded: vi.fn(),
      offerAcceptedByVendor: vi.fn(),
      quoteSubmittedToStore: vi.fn(),
      rfqAwarded: vi.fn(),
      notifyUsers: vi.fn(),
      notifyVendorUsers: vi.fn(),
    }
    return service.notifier
  }

  it('publish notifies every persisted recipient vendor', async () => {
    const { service } = makeService({
      findRequestById: vi.fn(async () => publishableRequest()),
      findRequestItems: vi.fn(async () => [RFQ_ITEM]),
      findEligibleVendorCandidates: vi.fn(async () => [candidate({ id: 'vendor-k' })]),
    })
    const notifier = stubNotifier(service)

    const result = await service.publishRequest('req-1', 'actor-1', HQ)

    expect(notifier.requestPublished).toHaveBeenCalledTimes(1)
    expect(notifier.requestPublished.mock.calls[0][0]).toHaveLength(1)
    expect(notifier.requestPublished.mock.calls[0][0][0].vendor_id).toBe('vendor-k')
    expect(notifier.requestPublished.mock.calls[0][1]).toMatchObject({ requestId: 'req-1', mode: 'RFQ' })
    expect(result.recipients).toHaveLength(1)
  })

  it('cancel and expire close out recipients with the right status payload', async () => {
    const cancelled = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ status: 'PUBLISHED' })),
      listRecipients: vi.fn(async () => [{ vendor_id: 'vendor-k' }]),
    })
    const cancelledNotifier = stubNotifier(cancelled.service)
    await cancelled.service.cancelRequest('req-1', 'actor-1', 'reason', HQ)
    expect(cancelledNotifier.requestClosed).toHaveBeenCalledWith(
      [{ vendor_id: 'vendor-k' }],
      expect.objectContaining({ status: 'CANCELLED', requestNumber: expect.any(String) })
    )

    const expired = makeService({
      findRequestById: vi.fn(async () => publishableRequest({ status: 'PUBLISHED' })),
      listRecipients: vi.fn(async () => [{ vendor_id: 'vendor-k' }]),
    })
    const expiredNotifier = stubNotifier(expired.service)
    await expired.service.expireRequest('req-1', 'actor-1', HQ)
    expect(expiredNotifier.requestClosed).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'EXPIRED' })
    )
  })

  it('fixed-offer accept notifies the winner and the request creator', async () => {
    const { service, repo } = makeService({
      findVendorStatus: vi.fn(async () => ({ id: 'vendor-1', status: 'ACTIVE', is_active: true })),
      findRequestById: vi.fn(async () => ({ ...publishableRequest(), mode: 'FIXED_OFFER', offer_total: 5000, created_by: 'admin-1' })),
      findRecipientByRequestAndVendor: vi.fn(async () => ({ id: 'rec-1', status: 'NEW' })),
      lockRequestTx: vi.fn(async () => ({ status: 'PUBLISHED' })),
      awardRequestTx: vi.fn(async () => ({ id: 'req-1', status: 'AWARDED' })),
      setRecipientStatus: vi.fn(async () => ({})),
      setOtherRecipientsNotSelectedTx: vi.fn(async () => []),
      findRequestItems: vi.fn(async () => []),
      insertSupplyOrderTx: vi.fn(async () => ({ id: 'supply-1', supply_number: 'SUP-X' })),
      insertSupplyOrderItemsTx: vi.fn(async () => []),
      insertSupplyEventTx: vi.fn(async () => ({})),
    })
    const notifier = stubNotifier(service)

    await service.acceptFixedOffer('req-1', 'vendor-1', 'actor-1')

    expect(notifier.offerAwarded).toHaveBeenCalledWith('vendor-1', expect.objectContaining({ supplyNumber: 'SUP-X' }))
    expect(notifier.offerAcceptedByVendor).toHaveBeenCalledWith('admin-1', expect.objectContaining({ requestNumber: expect.any(String) }))
  })

  it('RFQ award notifies winner, losers and the store', async () => {
    const awardQuoteObj = { id: 'quote-1', vendor_id: 'vendor-1', status: 'SUBMITTED', request_id: 'req-1', grand_total: 5000, items: [{ request_item_id: 'item-1', quoted_quantity: 20, unit_price: 250, line_total: 5000 }] }
    const { service } = makeService({
      findQuoteById: vi.fn(async () => awardQuoteObj),
      findRequestById: vi.fn(async () => ({ ...publishableRequest({ status: 'PUBLISHED' }), created_by: 'admin-1' })),
      findRecipientByRequestAndVendor: vi.fn(async () => ({ id: 'rec-1', status: 'RESPONDED' })),
      lockRequestTx: vi.fn(async () => ({ status: 'PUBLISHED' })),
      awardRequestTx: vi.fn(async () => ({ id: 'req-1', status: 'AWARDED' })),
      setQuoteStatus: vi.fn(async () => ({})),
      setOtherQuotesNotSelectedTx: vi.fn(async () => []),
      setOtherRecipientsNotSelectedTx: vi.fn(async () => []),
      findRequestItems: vi.fn(async () => [{ id: 'item-1', category_id: 'cat-1', item_name: 'Mutton', requested_quantity: 20, unit: 'KG' }]),
      listQuotesForRequest: vi.fn(async () => [
        { vendor_id: 'vendor-1', status: 'SELECTED' },
        { vendor_id: 'vendor-2', status: 'NOT_SELECTED' },
      ]),
      insertSupplyOrderTx: vi.fn(async () => ({ id: 'supply-1', supply_number: 'SUP-Y' })),
      insertSupplyOrderItemsTx: vi.fn(async () => []),
      insertSupplyEventTx: vi.fn(async () => ({})),
    })
    const notifier = stubNotifier(service)

    await service.awardQuote('quote-1', 'actor-1')

    expect(notifier.rfqAwarded).toHaveBeenCalledWith('vendor-1', ['vendor-2'], expect.objectContaining({ requestNumber: expect.any(String) }))
    expect(notifier.offerAcceptedByVendor).toHaveBeenCalledWith('admin-1', expect.anything())
  })

  it('quote submission notifies the store without touching other vendors', async () => {
    const { service } = makeService({
      findVendorStatus: vi.fn(async () => ({ id: 'vendor-1', name: 'Vendor One', status: 'ACTIVE', is_active: true })),
      findRequestById: vi.fn(async () => ({ ...publishableRequest({ status: 'PUBLISHED' }), created_by: 'admin-1' })),
      findRecipientByRequestAndVendor: vi.fn(async () => ({ id: 'rec-1', status: 'VIEWED' })),
      listQuotesForRequest: vi.fn(async () => [{ vendor_id: 'vendor-OTHER', status: 'SUBMITTED' }]),
      findRequestItems: vi.fn(async () => [{ id: 'item-1', category_id: 'cat-1', item_name: 'Mutton', requested_quantity: 20, unit: 'KG' }]),
      insertQuoteTx: vi.fn(async () => ({ id: 'quote-1' })),
      insertQuoteItemsTx: vi.fn(async () => []),
      markRecipientResponded: vi.fn(async () => {}),
    })
    const notifier = stubNotifier(service)

    await service.submitQuote('req-1', 'vendor-1', 'actor-1', {
      items: [{ request_item_id: 'item-1', quoted_quantity: 20, unit_price: 250 }],
    })

    expect(notifier.quoteSubmittedToStore).toHaveBeenCalledWith('admin-1', expect.objectContaining({ vendorName: 'Vendor One' }))
  })
})

describe('ProcurementNotifier failure tolerance', () => {
  it('resolves even when the underlying sendNotification rejects', async () => {
    const { ProcurementNotifier } = await import('../../../src/modules/vendor-procurement/vendor-procurement.notifications.js')
    const notifier = new ProcurementNotifier(null)
    notifier.notifications = { sendNotification: vi.fn(async () => { throw new Error('FCM down') }) }

    await expect(notifier.dispatch(['user-1'], { title: 't', body: 'b' })).resolves.toBeUndefined()
    expect(notifier.notifications.sendNotification).toHaveBeenCalledTimes(1)
  })
})

// ─── Video evidence + packing gate (Big Phase 12) ───────────────────────────

describe('attachEvidence and the PACKED gate', () => {
  function evidenceService(repoOverrides = {}) {
    return makeService({
      findSupplyOrderById: vi.fn(async () => ({
        id: 'supply-1',
        vendor_id: 'vendor-1',
        status: 'CLEANING',
        evidence: [],
        shop_id: 'shop-1',
      })),
      insertEvidence: vi.fn(async (data) => ({ id: 'ev-1', ...data })),
      updateSupplyStatus: vi.fn(async (_id, status) => ({ id: 'supply-1', status })),
      insertSupplyEvent: vi.fn(async () => ({ id: 'evt-1' })),
      ...repoOverrides,
    })
  }

  it('persists evidence and transitions CLEANING → VIDEO_SUBMITTED', async () => {
    const { service, repo } = evidenceService()

    const evidence = await service.attachEvidence('supply-1', 'vendor-1', 'actor-1', {
      media_public_id: 'evidence/vid-1',
      media_url: 'https://res.cloudinary.com/test/video.mp4',
      mime_type: 'video/mp4',
      duration_seconds: 34,
      size_bytes: 5242880,
    })

    expect(evidence.id).toBe('ev-1')
    expect(evidence.review_status).toBe('PENDING')
    expect(repo.updateSupplyStatus).toHaveBeenCalledWith('supply-1', 'VIDEO_SUBMITTED')
    expect(repo.insertSupplyEvent).toHaveBeenCalledWith(
      expect.objectContaining({ from_status: 'CLEANING', to_status: 'VIDEO_SUBMITTED' })
    )
  })

  it('rejects evidence for another vendor’s supply order', async () => {
    const { service } = evidenceService({
      findSupplyOrderById: vi.fn(async () => ({
        id: 'supply-1',
        vendor_id: 'vendor-OTHER',
        status: 'CLEANING',
        evidence: [],
      })),
    })

    await expect(
      service.attachEvidence('supply-1', 'vendor-1', 'actor-1', {
        media_public_id: 'x',
        media_url: 'https://x/y.mp4',
      })
    ).rejects.toMatchObject({ code: 'SUPPLY_ORDER_NOT_FOUND' })
  })

  it('rejects evidence once the supply is already dispatched', async () => {
    const { service } = evidenceService({
      findSupplyOrderById: vi.fn(async () => ({
        id: 'supply-1',
        vendor_id: 'vendor-1',
        status: 'DISPATCHED',
        evidence: [],
      })),
    })

    await expect(
      service.attachEvidence('supply-1', 'vendor-1', 'actor-1', {
        media_public_id: 'x',
        media_url: 'https://x/y.mp4',
      })
    ).rejects.toMatchObject({ code: 'SUPPLY_NOT_PREPARABLE' })
  })

  it('updateSupplyStatus allows PACKED only with accepted evidence', async () => {
    const withoutEvidence = makeService({
      findSupplyOrderById: vi.fn(async () => ({
        id: 'supply-1',
        vendor_id: 'vendor-1',
        status: 'CLEANING',
        shop_id: 'shop-1',
        evidence: [],
      })),
    })
    await expect(
      withoutEvidence.service.updateSupplyStatus('supply-1', 'vendor-1', 'actor-1', 'PACKED')
    ).rejects.toMatchObject({ code: 'SUPPLY_EVIDENCE_REQUIRED' })

    const withEvidence = makeService({
      findSupplyOrderById: vi.fn(async () => ({
        id: 'supply-1',
        vendor_id: 'vendor-1',
        status: 'CLEANING',
        shop_id: 'shop-1',
        evidence: [{ evidence_type: 'QUALITY_VIDEO', review_status: 'ACCEPTED' }],
      })),
      updateSupplyStatus: vi.fn(async (_id, status) => ({ id: 'supply-1', status })),
      insertSupplyEvent: vi.fn(async () => ({ id: 'evt-1' })),
    })
    const result = await withEvidence.service.updateSupplyStatus('supply-1', 'vendor-1', 'actor-1', 'PACKED')
    expect(result.status).toBe('PACKED')

    // Rejected evidence does not unlock packing.
    const withRejected = makeService({
      findSupplyOrderById: vi.fn(async () => ({
        id: 'supply-1',
        vendor_id: 'vendor-1',
        status: 'CLEANING',
        shop_id: 'shop-1',
        evidence: [{ evidence_type: 'QUALITY_VIDEO', review_status: 'REJECTED' }],
      })),
    })
    await expect(
      withRejected.service.updateSupplyStatus('supply-1', 'vendor-1', 'actor-1', 'PACKED')
    ).rejects.toMatchObject({ code: 'SUPPLY_EVIDENCE_REQUIRED' })
  })
})
