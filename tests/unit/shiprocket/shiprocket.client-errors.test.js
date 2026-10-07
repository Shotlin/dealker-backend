import { describe, it, expect, vi } from 'vitest'
import { ShiprocketClient } from '../../../src/modules/shiprocket/shiprocket.client.js'

const reply = (status, body) => async () => ({ ok: status < 400, status, text: async () => JSON.stringify(body) })

describe('ShiprocketClient error handling', () => {
  it('treats HTTP 200 with a failure status_code body as an error and includes field details', async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith('/auth/login')
        ? { ok: true, status: 200, text: async () => '{"token":"t"}' }
        : { ok: true, status: 200, text: async () => JSON.stringify({ status_code: 422, message: 'Wrong pickup', errors: { pickup_location: ['not found'] } }) })
    const c = new ShiprocketClient({ email: 'a', password: 'b' }, fetchImpl)
    await expect(c.createQuickOrder({})).rejects.toThrow(/Wrong pickup.*pickup_location: not found/)
  })

  it('a normal success body passes through untouched', async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.endsWith('/auth/login')
        ? { ok: true, status: 200, text: async () => '{"token":"t"}' }
        : { ok: true, status: 200, text: async () => '{"order_id":1,"shipment_id":2}' })
    const c = new ShiprocketClient({ email: 'a', password: 'b' }, fetchImpl)
    expect(await c.createQuickOrder({})).toEqual({ order_id: 1, shipment_id: 2 })
  })
})
