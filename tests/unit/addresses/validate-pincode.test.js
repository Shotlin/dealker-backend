// validate-pincode (gate G1): PIN normalisation + the in-process PIN cache that
// ShopsService now invalidates when a shop's service area changes.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const databaseMock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../../src/config/database.js', () => databaseMock)
vi.mock('../../../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../src/config/env.js', () => ({ env: { ALLOW_ALL_PINCODES: false } }))

import { AddressesService } from '../../../src/modules/addresses/addresses.service.js'
import { invalidateServiceablePincodeCache } from '../../../src/utils/serviceable-pincode-cache.js'

function makeService({ allocationRepository = {} } = {}) {
  return new AddressesService({}, {
    allocationRepository,
    pincodeMappingsRepository: { findActiveByPincode: vi.fn().mockResolvedValue(null) },
    feeSettingsRepository: { getGlobal: vi.fn().mockResolvedValue({ delivery_eta_minutes: 30 }) },
  })
}

const shopsWithPins = (...pins) => ({ rows: pins.map((pincode) => ({ pincode })) })

beforeEach(() => {
  vi.clearAllMocks()
  invalidateServiceablePincodeCache()
})

describe('AddressesService.validatePincode()', () => {
  it('is available for a configured PIN and unavailable for another', async () => {
    databaseMock.query.mockResolvedValue(shopsWithPins('201301'))
    const service = makeService()

    expect((await service.validatePincode('201301')).available).toBe(true)
    expect((await service.validatePincode('201302')).available).toBe(false)
  })

  it('duplicate / whitespace-padded stored entries behave as one clean PIN', async () => {
    databaseMock.query.mockResolvedValue(shopsWithPins('201301', ' 201301', '201301 ', '', '   '))
    const service = makeService()

    expect((await service.validatePincode('201301')).available).toBe(true)
    expect((await service.validatePincode(' 201301 ')).available).toBe(true)
    expect((await service.validatePincode('201302')).available).toBe(false)
  })

  it('caches the PIN set, and stays fresh after invalidateServiceablePincodeCache()', async () => {
    databaseMock.query.mockResolvedValueOnce(shopsWithPins('700016'))
    const service = makeService()

    expect((await service.validatePincode('201301')).available).toBe(false)
    expect(databaseMock.query).toHaveBeenCalledTimes(1)

    // Dashboard adds 201301 — without invalidation the stale set would still answer "no".
    databaseMock.query.mockResolvedValueOnce(shopsWithPins('700016', '201301'))
    expect((await service.validatePincode('201301')).available).toBe(false)
    expect(databaseMock.query).toHaveBeenCalledTimes(1)

    invalidateServiceablePincodeCache()
    expect((await service.validatePincode('201301')).available).toBe(true)
    expect(databaseMock.query).toHaveBeenCalledTimes(2)
  })

  it('allows all when no shop has any PIN configured (unchanged) and does not cache that', async () => {
    databaseMock.query.mockResolvedValue({ rows: [] })
    const service = makeService()

    expect((await service.validatePincode('201301')).available).toBe(true)
    expect((await service.validatePincode('201301')).available).toBe(true)
    expect(databaseMock.query).toHaveBeenCalledTimes(2)
  })
})

// Regression: the Add Address screen's live pincode check (this same
// endpoint) reported "not available" for a pin the customer had genuinely
// map-selected inside a shop's delivery radius, because this check only
// ever consulted the pincode LIST — never radius — unlike the actual
// address save / allocation gates, which already accept pincode OR radius.
// validatePincode(pincode, lat, lng) now falls back to
// AllocationRepository#isServiceable (the exact same rule) when the plain
// list check says no and a map pin (lat/lng) was supplied.
describe('AddressesService.validatePincode() — radius fallback with lat/lng', () => {
  it('falls back to radius-based isServiceable when the pincode list says no', async () => {
    databaseMock.query.mockResolvedValue(shopsWithPins('700016'))
    const isServiceable = vi.fn().mockResolvedValue(true)
    const service = makeService({ allocationRepository: { isServiceable } })

    const result = await service.validatePincode('110001', 28.6139, 77.209)

    expect(result.available).toBe(true)
    expect(isServiceable).toHaveBeenCalledWith({
      pincode: '110001',
      lat: 28.6139,
      lng: 77.209,
    })
  })

  it('stays unavailable when radius also rejects it', async () => {
    databaseMock.query.mockResolvedValue(shopsWithPins('700016'))
    const isServiceable = vi.fn().mockResolvedValue(false)
    const service = makeService({ allocationRepository: { isServiceable } })

    const result = await service.validatePincode('999999', 1, 1)

    expect(result.available).toBe(false)
    expect(isServiceable).toHaveBeenCalledOnce()
  })

  it('never calls isServiceable when no lat/lng were given — unaffected callers keep exact prior behaviour', async () => {
    databaseMock.query.mockResolvedValue(shopsWithPins('700016'))
    const isServiceable = vi.fn().mockResolvedValue(true)
    const service = makeService({ allocationRepository: { isServiceable } })

    const result = await service.validatePincode('110001')

    expect(result.available).toBe(false)
    expect(isServiceable).not.toHaveBeenCalled()
  })

  it('never calls isServiceable when the pincode already matched the list', async () => {
    databaseMock.query.mockResolvedValue(shopsWithPins('700016'))
    const isServiceable = vi.fn().mockResolvedValue(true)
    const service = makeService({ allocationRepository: { isServiceable } })

    const result = await service.validatePincode('700016', 22.57, 88.36)

    expect(result.available).toBe(true)
    expect(isServiceable).not.toHaveBeenCalled()
  })

  it('treats non-finite lat/lng (e.g. undefined/NaN) as "no coords given"', async () => {
    databaseMock.query.mockResolvedValue(shopsWithPins('700016'))
    const isServiceable = vi.fn().mockResolvedValue(true)
    const service = makeService({ allocationRepository: { isServiceable } })

    const result = await service.validatePincode('110001', Number.NaN, Number.NaN)

    expect(result.available).toBe(false)
    expect(isServiceable).not.toHaveBeenCalled()
  })
})
