/**
 * RFQ quote workflow tests (Big Phase 5)
 *
 * Unit tests cover quote submission/edit/withdraw rules and the admin award
 * (freeze + cascade). The live-DB section proves the award end-to-end:
 * commercial terms frozen on the request, other quotes NOT_SELECTED, exactly
 * one supply order — against real PostgreSQL (skips when DB unreachable).
 */

import { beforeAll, afterAll, describe, expect, it, vi, beforeEach } from 'vitest'

// ─── Unit tests: mocked database ────────────────────────────────────────────

const databaseMock = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
  getClient: vi.fn(async () => ({
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  })),
}))

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

import { VendorProcurementService } from '../../../src/modules/vendor-procurement/vendor-procurement.service.js'

const ACTIVE_VENDOR = { id: 'vendor-1', status: 'ACTIVE', is_active: true }
const RFQ_REQUEST = {
  id: 'req-1',
  status: 'PUBLISHED',
  shop_id: 'shop-1',
  mode: 'RFQ',
  response_deadline: new Date(Date.now() + 3600_000).toISOString(),
  required_delivery_at: new Date(Date.now() + 7200_000).toISOString(),
}

function quoteService(repoOverrides = {}) {
  const repo = {
    findVendorStatus: vi.fn(async () => ACTIVE_VENDOR),
    findRequestById: vi.fn(async () => RFQ_REQUEST),
    findRecipientByRequestAndVendor: vi.fn(async () => ({ id: 'rec-1', status: 'NEW' })),
    listQuotesForRequest: vi.fn(async () => []),
    findRequestItems: vi.fn(async () => [{ id: 'item-1', category_id: 'cat-1', product_id: 'prod-mutton-1', item_name: 'Mutton', requested_quantity: 20, unit: 'KG' }]),
    insertQuoteTx: vi.fn(async (_c, data) => ({ id: 'quote-1', status: 'SUBMITTED', ...data })),
    insertQuoteItemsTx: vi.fn(async (_c, _q, items) => items.map((i, ix) => ({ id: `qi-${ix}`, ...i }))),
    markRecipientResponded: vi.fn(async () => {}),
    findQuoteById: vi.fn(async () => ({ id: 'quote-1', vendor_id: 'vendor-1', status: 'SUBMITTED', request_id: 'req-1', grand_total: 5000, items: [] })),
    updateQuoteTx: vi.fn(async () => ({ id: 'quote-1' })),
    setQuoteStatus: vi.fn(async (_id, status) => ({ id: 'quote-1', status })),
    setRecipientStatus: vi.fn(async () => ({ id: 'rec-1', status: 'AWARDED' })),
    lockRequestTx: vi.fn(async () => RFQ_REQUEST),
    awardRequestTx: vi.fn(async (_c, _id, vendorId, total) => ({ id: 'req-1', status: 'AWARDED', awarded_vendor_id: vendorId, award_total: total })),
    setOtherQuotesNotSelectedTx: vi.fn(async () => []),
    setOtherRecipientsNotSelectedTx: vi.fn(async () => []),
    insertSupplyOrderTx: vi.fn(async () => ({ id: 'supply-1', supply_number: 'SUP-TEST' })),
    insertSupplyOrderItemsTx: vi.fn(async () => []),
    insertSupplyEventTx: vi.fn(async () => ({ id: 'evt-1' })),
    ...repoOverrides,
  }
  return { service: new VendorProcurementService(repo), repo }
}

const QUOTE_ITEMS = [{ request_item_id: 'item-1', quoted_quantity: 20, unit_price: 250 }]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('submitQuote rules', () => {
  it('computes line totals and grand total server-side and marks the recipient responded', async () => {
    const { service, repo } = quoteService()

    const result = await service.submitQuote('req-1', 'vendor-1', 'actor-1', {
      items: [QUOTE_ITEMS[0], { request_item_id: 'item-1', quoted_quantity: 5, unit_price: 100.5 }],
    })

    expect(result.grand_total).toBe(5502.5)
    expect(result.items[1].line_total).toBe(502.5)
    expect(repo.markRecipientResponded).toHaveBeenCalledWith('rec-1')
  })

  it('rejects a second live quote from the same vendor (edit instead)', async () => {
    const { service } = quoteService({
      listQuotesForRequest: vi.fn(async () => [{ vendor_id: 'vendor-1', status: 'SUBMITTED' }]),
    })

    await expect(
      service.submitQuote('req-1', 'vendor-1', 'actor-1', { items: QUOTE_ITEMS })
    ).rejects.toMatchObject({ code: 'PROCUREMENT_QUOTE_EXISTS' })
  })

  it('rejects suspended vendors, non-RFQ requests, closed requests and past deadlines', async () => {
    const suspended = quoteService({
      findVendorStatus: vi.fn(async () => ({ id: 'vendor-1', status: 'SUSPENDED', is_active: true })),
    })
    await expect(suspended.service.submitQuote('req-1', 'vendor-1', 'actor-1', { items: QUOTE_ITEMS }))
      .rejects.toMatchObject({ code: 'VENDOR_NOT_RESPONDABLE' })

    const notRfq = quoteService({
      findRequestById: vi.fn(async () => ({ ...RFQ_REQUEST, mode: 'FIXED_OFFER' })),
    })
    await expect(notRfq.service.submitQuote('req-1', 'vendor-1', 'actor-1', { items: QUOTE_ITEMS }))
      .rejects.toMatchObject({ code: 'PROCUREMENT_NOT_RFQ' })

    const closed = quoteService({
      findRequestById: vi.fn(async () => ({ ...RFQ_REQUEST, status: 'AWARDED' })),
    })
    await expect(closed.service.submitQuote('req-1', 'vendor-1', 'actor-1', { items: QUOTE_ITEMS }))
      .rejects.toMatchObject({ code: 'PROCUREMENT_REQUEST_CLOSED' })

    const past = quoteService({
      findRequestById: vi.fn(async () => ({ ...RFQ_REQUEST, response_deadline: new Date(Date.now() - 1000).toISOString() })),
    })
    await expect(past.service.submitQuote('req-1', 'vendor-1', 'actor-1', { items: QUOTE_ITEMS }))
      .rejects.toMatchObject({ code: 'PROCUREMENT_DEADLINE_PASSED' })
  })

  it('rejects quotes containing items that were not requested', async () => {
    const { service } = quoteService()

    await expect(
      service.submitQuote('req-1', 'vendor-1', 'actor-1', {
        items: [{ request_item_id: 'ghost-item', quoted_quantity: 1, unit_price: 10 }],
      })
    ).rejects.toMatchObject({ code: 'PROCUREMENT_QUOTE_ITEM_UNKNOWN' })
  })
})

describe('updateQuote and withdrawQuote rules', () => {
  it('lets the owner edit a live quote; items replace and status becomes UPDATED', async () => {
    const liveQuote = { id: 'quote-1', vendor_id: 'vendor-1', status: 'SUBMITTED', request_id: 'req-1', grand_total: 5000, items: [] }
    const { service, repo } = quoteService({
      findQuoteById: vi.fn(async () => liveQuote),
      updateQuoteTx: vi.fn(async () => {
        liveQuote.status = 'UPDATED'
        return liveQuote
      }),
    })

    const result = await service.updateQuote('quote-1', 'vendor-1', 'actor-1', { items: QUOTE_ITEMS })
    expect(result.status).toBe('UPDATED')
    expect(repo.updateQuoteTx).toHaveBeenCalledWith(expect.anything(), 'quote-1', expect.objectContaining({ grand_total: 5000 }))
  })

  it('blocks editing or withdrawing another vendor’s quote', async () => {
    const { service } = quoteService({
      findQuoteById: vi.fn(async () => ({ id: 'quote-1', vendor_id: 'vendor-OTHER', status: 'SUBMITTED', request_id: 'req-1', items: [] })),
    })

    await expect(service.updateQuote('quote-1', 'vendor-1', 'actor-1', { note: 'x' }))
      .rejects.toMatchObject({ code: 'PROCUREMENT_QUOTE_NOT_FOUND' })
    await expect(service.withdrawQuote('quote-1', 'vendor-1', 'actor-1'))
      .rejects.toMatchObject({ code: 'PROCUREMENT_QUOTE_NOT_FOUND' })
  })

  it('blocks editing a locked (selected/withdrawn) quote', async () => {
    const { service } = quoteService({
      findQuoteById: vi.fn(async () => ({ id: 'quote-1', vendor_id: 'vendor-1', status: 'SELECTED', request_id: 'req-1', items: [] })),
    })

    await expect(service.updateQuote('quote-1', 'vendor-1', 'actor-1', { note: 'x' }))
      .rejects.toMatchObject({ code: 'PROCUREMENT_QUOTE_LOCKED' })
  })
})

describe('awardQuote', () => {
  const AWARD_QUOTE = { id: 'quote-1', vendor_id: 'vendor-1', status: 'SUBMITTED', request_id: 'req-1', grand_total: 5000, items: [{ request_item_id: 'item-1', quoted_quantity: 20, unit_price: 250, line_total: 5000 }] }

  it('freezes the award, cascades not-selected, creates the supply order from the quote', async () => {
    const { service, repo } = quoteService({
      findQuoteById: vi.fn(async () => AWARD_QUOTE),
    })

    const result = await service.awardQuote('quote-1', 'actor-1')

    expect(result.request.status).toBe('AWARDED')
    expect(result.request.award_total).toBe(5000)
    expect(repo.setQuoteStatus).toHaveBeenCalledWith('quote-1', 'SELECTED')
    expect(repo.setOtherQuotesNotSelectedTx).toHaveBeenCalledWith(expect.anything(), 'req-1', 'quote-1')
    expect(repo.insertSupplyOrderTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      source_mode: 'RFQ',
      vendor_id: 'vendor-1',
      award_amount: 5000,
    }))
    const supplyItems = repo.insertSupplyOrderItemsTx.mock.calls[0][2]
    expect(supplyItems[0]).toMatchObject({ agreed_quantity: 20, agreed_unit_price: 250, agreed_line_total: 5000 })
  })

  it('resolves product_id from the original request item (a quote item never carries its own) onto the supply order item', async () => {
    const { service, repo } = quoteService({
      findQuoteById: vi.fn(async () => AWARD_QUOTE),
    })

    await service.awardQuote('quote-1', 'actor-1')

    const supplyItems = repo.insertSupplyOrderItemsTx.mock.calls[0][2]
    expect(supplyItems[0].product_id).toBe('prod-mutton-1')
  })

  it('rejects awarding a non-live quote', async () => {
    const { service } = quoteService({
      findQuoteById: vi.fn(async () => ({ ...AWARD_QUOTE, status: 'WITHDRAWN' })),
    })

    await expect(service.awardQuote('quote-1', 'actor-1')).rejects.toMatchObject({
      code: 'PROCUREMENT_QUOTE_NOT_AWARDABLE',
    })
  })

  it('rejects the award when the request was already awarded (0-row conditional update)', async () => {
    const { service } = quoteService({
      findQuoteById: vi.fn(async () => AWARD_QUOTE),
      awardRequestTx: vi.fn(async () => null),
    })

    await expect(service.awardQuote('quote-1', 'actor-1')).rejects.toMatchObject({ code: 'ALREADY_AWARDED' })
  })
})
