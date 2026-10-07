import { describe, it, expect } from 'vitest'
import { resolveCustomerContext } from '../../../src/modules/products/products.controller.js'

const req = (user) => ({ user, headers: {}, server: { jwt: { verify: async () => ({}) } } })

describe('resolveCustomerContext role scoping', () => {
  it('scopes a CUSTOMER to their allocation', async () => {
    expect(await resolveCustomerContext(req({ id: 'u1', role: 'CUSTOMER' }))).toEqual({ userId: 'u1' })
  })

  it('scopes a RIDER-role account too (rider login flips a customer account to RIDER)', async () => {
    expect(await resolveCustomerContext(req({ id: 'u1', role: 'RIDER' }))).toEqual({ userId: 'u1' })
  })

  it('keeps ADMIN / shop staff unscoped', async () => {
    expect(await resolveCustomerContext(req({ id: 'a1', role: 'ADMIN' }))).toBeNull()
    expect(await resolveCustomerContext(req({ id: 's1', role: 'SHOP_MANAGER' }))).toBeNull()
  })
})
