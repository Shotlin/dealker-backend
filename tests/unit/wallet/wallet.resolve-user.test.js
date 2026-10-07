// Coverage for WalletService.resolveUser() attaching recentPaidOrders —
// the Credit Wallet dialog's "does this amount match a real paid order"
// warning depends on this field being present so an admin can catch
// crediting money for an order that was never actually paid for.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({
  getClient: vi.fn(),
}))
vi.mock('../../../src/config/database.js', () => databaseMock)

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WalletService } from '../../../src/modules/wallet/wallet.service.js'

function makeRepoMock(overrides = {}) {
  return {
    findUserById: vi.fn().mockResolvedValue({ id: 'user-1', name: 'Ashish', phone: '6354302166' }),
    findUserByPhone: vi.fn().mockResolvedValue(null),
    getRecentPaidOrderAmounts: vi.fn().mockResolvedValue([{ orderNumber: 'BKLOO-1', amount: 73 }]),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WalletService.resolveUser', () => {
  it('attaches recentPaidOrders to a UUID match', async () => {
    const repo = makeRepoMock()
    const service = new WalletService(repo)

    const result = await service.resolveUser('11111111-1111-1111-1111-111111111111')

    expect(repo.getRecentPaidOrderAmounts).toHaveBeenCalledWith('user-1')
    expect(result).toEqual({
      id: 'user-1',
      name: 'Ashish',
      phone: '6354302166',
      recentPaidOrders: [{ orderNumber: 'BKLOO-1', amount: 73 }],
    })
  })

  it('attaches recentPaidOrders to a phone-number match', async () => {
    const repo = makeRepoMock({
      findUserByPhone: vi.fn().mockResolvedValue({ id: 'user-1', name: 'Ashish', phone: '6354302166' }),
    })
    const service = new WalletService(repo)

    const result = await service.resolveUser('6354302166')

    expect(repo.findUserByPhone).toHaveBeenCalledWith('6354302166')
    expect(result?.recentPaidOrders).toEqual([{ orderNumber: 'BKLOO-1', amount: 73 }])
  })

  it('returns null without querying paid orders when no user matches', async () => {
    const repo = makeRepoMock({ findUserById: vi.fn().mockResolvedValue(null) })
    const service = new WalletService(repo)

    const result = await service.resolveUser('11111111-1111-1111-1111-111111111111')

    expect(result).toBeNull()
    expect(repo.getRecentPaidOrderAmounts).not.toHaveBeenCalled()
  })
})
