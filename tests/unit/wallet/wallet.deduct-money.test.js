// Coverage for WalletService.deductMoney() — the cashback-clawback debit
// path (Phase 2 of the customer-segment marketing system). Mocks
// config/database.js for the transaction wrapper and injects a mock
// WalletRepository via the constructor, so no real DB/SQL is touched.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({
  getClient: vi.fn(),
}))
vi.mock('../../../src/config/database.js', () => databaseMock)

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WalletService } from '../../../src/modules/wallet/wallet.service.js'

const USER_ID = 'user-1'

function makeClientMock() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }
}

function makeRepoMock(overrides = {}) {
  return {
    getForUpdate: vi.fn().mockResolvedValue({ id: 'wallet-1', balance: 100 }),
    debit: vi.fn().mockResolvedValue({
      wallet: { id: 'wallet-1', balance: 50 },
      transaction: { id: 'wtx-1', amount: 50 },
    }),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WalletService.deductMoney (positive/negative)', () => {
  it('debits the full requested amount when the balance covers it (positive)', async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock({ getForUpdate: vi.fn().mockResolvedValue({ id: 'wallet-1', balance: 100 }) })
    const service = new WalletService(repo)

    const result = await service.deductMoney(USER_ID, { amount: 50, description: 'Cashback reversed' })

    expect(result.success).toBe(true)
    expect(result.deducted).toBe(50)
    expect(repo.debit).toHaveBeenCalledWith(client, 'wallet-1', 50, 'Cashback reversed', undefined, {
      subType: undefined,
      sourceId: undefined,
      orderId: undefined,
    })
    expect(client.query).toHaveBeenCalledWith('COMMIT')
  })

  it('debits only the remaining balance when it is less than the requested amount (partial clawback)', async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock({ getForUpdate: vi.fn().mockResolvedValue({ id: 'wallet-1', balance: 20 }) })
    const service = new WalletService(repo)

    const result = await service.deductMoney(USER_ID, { amount: 50, description: 'Cashback reversed' })

    expect(result.success).toBe(true)
    expect(repo.debit).toHaveBeenCalledWith(client, 'wallet-1', 20, 'Cashback reversed', undefined, expect.any(Object))
  })

  it('skips the debit entirely (no error) when the wallet balance is already zero (negative)', async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock({ getForUpdate: vi.fn().mockResolvedValue({ id: 'wallet-1', balance: 0 }) })
    const service = new WalletService(repo)

    const result = await service.deductMoney(USER_ID, { amount: 50, description: 'Cashback reversed' })

    expect(result.success).toBe(true)
    expect(result.deducted).toBe(0)
    expect(repo.debit).not.toHaveBeenCalled()
    expect(client.query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('returns success:false when the wallet does not exist (negative)', async () => {
    const client = makeClientMock()
    databaseMock.getClient.mockResolvedValue(client)
    const repo = makeRepoMock({ getForUpdate: vi.fn().mockResolvedValue(null) })
    const service = new WalletService(repo)

    const result = await service.deductMoney(USER_ID, { amount: 50 })

    expect(result.success).toBe(false)
  })
})
