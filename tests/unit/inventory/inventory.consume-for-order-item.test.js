import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { InventoryService } from '../../../src/modules/inventory/inventory.service.js'

function makeLot(overrides = {}) {
  return {
    id: 'lot-1',
    quantity_on_hand: 5,
    quantity_reserved: 0,
    ...overrides,
  }
}

function makeRepository(overrides = {}) {
  return {
    findAvailableLotsFefo: vi.fn(async () => []),
    consumeLotOnHand: vi.fn(async (lotId, qty) => ({ id: lotId, quantity_on_hand: 0 })),
    writeLedgerEntry: vi.fn(async () => ({})),
    insertOrderItemAllocation: vi.fn(async (client, data) => ({ id: `alloc-${data.inventoryLotId}`, ...data })),
    ...overrides,
  }
}

describe('InventoryService#consumeForOrderItem', () => {
  it('is a no-op when required identifiers are missing (never throws)', async () => {
    const repository = makeRepository()
    const service = new InventoryService(repository)

    const result = await service.consumeForOrderItem('actor-1', {
      warehouseId: null,
      productId: 'p-1',
      orderItemId: 'oi-1',
      quantity: 2,
    })

    expect(result.allocations).toEqual([])
    expect(repository.findAvailableLotsFefo).not.toHaveBeenCalled()
  })

  it('consumes a single lot fully when it has enough stock', async () => {
    const lot = makeLot({ id: 'lot-a', quantity_on_hand: 10 })
    const repository = makeRepository({
      findAvailableLotsFefo: vi.fn(async () => [lot]),
      consumeLotOnHand: vi.fn(async (lotId, qty) => ({ id: lotId, quantity_on_hand: 10 - qty })),
    })
    const service = new InventoryService(repository)

    const result = await service.consumeForOrderItem('actor-1', {
      warehouseId: 'wh-1',
      productId: 'prod-1',
      orderItemId: 'oi-1',
      quantity: 3,
    }, 'tx-client')

    expect(repository.consumeLotOnHand).toHaveBeenCalledWith('lot-a', 3, 'tx-client')
    expect(repository.insertOrderItemAllocation).toHaveBeenCalledWith('tx-client', {
      orderItemId: 'oi-1',
      inventoryLotId: 'lot-a',
      quantityAllocated: 3,
    })
    expect(result.allocations).toHaveLength(1)
    // Regression test for a real production incident: writeLedgerEntry
    // MUST run on the same transaction client as consumeLotOnHand's own
    // UPDATE — a plain pool query() here (a second, unrelated connection)
    // would block waiting on a lock that connection's own open transaction
    // holds, deadlocking every order that reaches this step (confirmed
    // live: every `placeOrder` call hung forever until the connection
    // pool was fully exhausted).
    expect(repository.writeLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        lot_id: 'lot-a',
        movement_type: 'OUTBOUND',
        quantity_change: -3,
        reference_type: 'ORDER_ITEM',
        reference_id: 'oi-1',
      }),
      'tx-client'
    )
  })

  it('spills across an old near-finished lot into a newly arrived lot (the "2kg left + new stock" scenario)', async () => {
    // Old lot has only 2 left; a new lot (later expiry / later created) has
    // plenty. FEFO ordering means the repository already hands lots back
    // oldest-expiry-first — the service must drain the old one before
    // touching the new one, and record BOTH allocations for one sale.
    const oldLot = makeLot({ id: 'lot-old', quantity_on_hand: 2 })
    const newLot = makeLot({ id: 'lot-new', quantity_on_hand: 20 })
    const repository = makeRepository({
      findAvailableLotsFefo: vi.fn(async () => [oldLot, newLot]),
      consumeLotOnHand: vi.fn(async (lotId, qty) => {
        const source = lotId === 'lot-old' ? oldLot : newLot
        return { id: lotId, quantity_on_hand: Number(source.quantity_on_hand) - qty }
      }),
    })
    const service = new InventoryService(repository)

    const result = await service.consumeForOrderItem('actor-1', {
      warehouseId: 'wh-1',
      productId: 'prod-1',
      orderItemId: 'oi-1',
      quantity: 5, // 2 from the old lot + 3 from the new one
    }, 'tx-client')

    expect(repository.consumeLotOnHand).toHaveBeenNthCalledWith(1, 'lot-old', 2, 'tx-client')
    expect(repository.consumeLotOnHand).toHaveBeenNthCalledWith(2, 'lot-new', 3, 'tx-client')
    expect(result.allocations).toHaveLength(2)
    expect(result.allocations[0]).toMatchObject({ inventoryLotId: 'lot-old', quantityAllocated: 2 })
    expect(result.allocations[1]).toMatchObject({ inventoryLotId: 'lot-new', quantityAllocated: 3 })
  })

  it('never throws when no lot covers the sale — partial/zero allocation is a warning, not an error', async () => {
    const repository = makeRepository({
      findAvailableLotsFefo: vi.fn(async () => []),
    })
    const service = new InventoryService(repository)

    await expect(
      service.consumeForOrderItem('actor-1', {
        warehouseId: 'wh-1',
        productId: 'prod-1',
        orderItemId: 'oi-1',
        quantity: 5,
      })
    ).resolves.toEqual({ allocations: [] })
    expect(repository.insertOrderItemAllocation).not.toHaveBeenCalled()
  })

  it('skips a lot that lost a race to consumeLotOnHand (returns null) and tries the next one', async () => {
    const lotA = makeLot({ id: 'lot-a', quantity_on_hand: 3 })
    const lotB = makeLot({ id: 'lot-b', quantity_on_hand: 10 })
    const repository = makeRepository({
      findAvailableLotsFefo: vi.fn(async () => [lotA, lotB]),
      consumeLotOnHand: vi.fn(async (lotId) => (lotId === 'lot-a' ? null : { id: 'lot-b', quantity_on_hand: 6 })),
    })
    const service = new InventoryService(repository)

    const result = await service.consumeForOrderItem('actor-1', {
      warehouseId: 'wh-1',
      productId: 'prod-1',
      orderItemId: 'oi-1',
      quantity: 4,
    })

    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0]).toMatchObject({ inventoryLotId: 'lot-b' })
  })
})

describe('InventoryService#getQualityTraceForOrderItems', () => {
  it('delegates to the repository unchanged', async () => {
    const rows = [{ order_item_id: 'oi-1', video_url: 'https://x/y.mp4' }]
    const repository = { findQualityTraceForOrderItems: vi.fn(async () => rows) }
    const service = new InventoryService(repository)

    const result = await service.getQualityTraceForOrderItems(['oi-1'])

    expect(repository.findQualityTraceForOrderItems).toHaveBeenCalledWith(['oi-1'])
    expect(result).toBe(rows)
  })
})
