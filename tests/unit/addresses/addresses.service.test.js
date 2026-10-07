// Coverage for the new hard serviceability gate in AddressesService.create()
// and update() — previously an address (and, downstream, an order against
// it) could be saved with any pincode/location, regardless of whether any
// shop actually served it. This only tests the new gate, not the whole
// file — mocks both the address repository and the allocation repository
// via constructor injection.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { AddressesService } from '../../../src/modules/addresses/addresses.service.js'

function makeAddressRepoMock(overrides = {}) {
  return {
    countByUser: vi.fn().mockResolvedValue(1),
    create: vi.fn().mockResolvedValue({ id: 'addr-1', isDefault: false }),
    setDefault: vi.fn().mockResolvedValue({ id: 'addr-1', isDefault: true }),
    findByIdAndUser: vi.fn().mockResolvedValue({
      id: 'addr-1',
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
      label: 'Home',
    }),
    update: vi.fn().mockResolvedValue({ id: 'addr-1' }),
    ...overrides,
  }
}

function makeAllocationRepoMock(isServiceable = true) {
  return {
    isServiceable: vi.fn().mockResolvedValue(isServiceable),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AddressesService.create() — serviceability gate', () => {
  it('rejects with ADDRESS_NOT_SERVICEABLE when no shop covers the address', async () => {
    const addressRepo = makeAddressRepoMock()
    const allocationRepo = makeAllocationRepoMock(false)
    const service = new AddressesService(addressRepo, { allocationRepository: allocationRepo })

    const result = await service.create('user-1', {
      lat: 21.17,
      lng: 72.89,
      pincode: '394210',
    })

    expect(result).toEqual({
      success: false,
      message: 'Delivery is not available at this address yet.',
      code: 'ADDRESS_NOT_SERVICEABLE',
    })
    expect(allocationRepo.isServiceable).toHaveBeenCalledWith({
      pincode: '394210',
      lat: 21.17,
      lng: 72.89,
    })
    // Must never reach the DB write when unserviceable.
    expect(addressRepo.create).not.toHaveBeenCalled()
  })

  it('proceeds to save when a shop covers the address', async () => {
    const addressRepo = makeAddressRepoMock()
    const allocationRepo = makeAllocationRepoMock(true)
    const service = new AddressesService(addressRepo, { allocationRepository: allocationRepo })

    const result = await service.create('user-1', {
      lat: 12.97,
      lng: 77.59,
      pincode: '560001',
    })

    expect(result.success).toBe(true)
    expect(addressRepo.create).toHaveBeenCalledTimes(1)
  })

  it('still checks coordinates before serviceability (existing gate unchanged)', async () => {
    const addressRepo = makeAddressRepoMock()
    const allocationRepo = makeAllocationRepoMock(true)
    const service = new AddressesService(addressRepo, { allocationRepository: allocationRepo })

    const result = await service.create('user-1', { pincode: '560001' })

    expect(result.code).toBe('ADDRESS_COORDINATES_REQUIRED')
    expect(allocationRepo.isServiceable).not.toHaveBeenCalled()
  })
})

describe('AddressesService.update() — serviceability gate', () => {
  it('rejects when the address is moved to an unserviceable location', async () => {
    const addressRepo = makeAddressRepoMock()
    const allocationRepo = makeAllocationRepoMock(false)
    const service = new AddressesService(addressRepo, { allocationRepository: allocationRepo })

    const result = await service.update('user-1', 'addr-1', {
      lat: 21.17,
      lng: 72.89,
      pincode: '394210',
    })

    expect(result).toEqual({
      success: false,
      message: 'Delivery is not available at this address yet.',
      code: 'ADDRESS_NOT_SERVICEABLE',
    })
    expect(addressRepo.update).not.toHaveBeenCalled()
  })

  it('skips the serviceability re-check when only an unrelated field changes', async () => {
    const addressRepo = makeAddressRepoMock()
    const allocationRepo = makeAllocationRepoMock(true)
    const service = new AddressesService(addressRepo, { allocationRepository: allocationRepo })

    const result = await service.update('user-1', 'addr-1', { label: 'Work' })

    expect(result.success).toBe(true)
    expect(allocationRepo.isServiceable).not.toHaveBeenCalled()
    expect(addressRepo.update).toHaveBeenCalledTimes(1)
  })

  it('re-checks when the pincode changes even without new coordinates', async () => {
    const addressRepo = makeAddressRepoMock()
    const allocationRepo = makeAllocationRepoMock(false)
    const service = new AddressesService(addressRepo, { allocationRepository: allocationRepo })

    const result = await service.update('user-1', 'addr-1', { pincode: '394210' })

    expect(result.code).toBe('ADDRESS_NOT_SERVICEABLE')
    expect(allocationRepo.isServiceable).toHaveBeenCalledWith({
      pincode: '394210',
      lat: 12.97,
      lng: 77.59,
    })
  })

  it('proceeds when the new location is serviceable', async () => {
    const addressRepo = makeAddressRepoMock()
    const allocationRepo = makeAllocationRepoMock(true)
    const service = new AddressesService(addressRepo, { allocationRepository: allocationRepo })

    const result = await service.update('user-1', 'addr-1', {
      lat: 12.98,
      lng: 77.6,
      pincode: '560002',
    })

    expect(result.success).toBe(true)
    expect(addressRepo.update).toHaveBeenCalledTimes(1)
  })
})
