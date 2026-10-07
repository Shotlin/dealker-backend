import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/utils/audit-log.js', () => ({ emit: vi.fn() }))

const { ShiprocketService } = await import('../../../src/modules/shiprocket/shiprocket.service.js')
const { ShiprocketClient } = await import('../../../src/modules/shiprocket/shiprocket.client.js')

function repo(overrides = {}) {
  return {
    get: vi.fn().mockResolvedValue({ api_email: 'api@x.com', api_password_encrypted: 'enc' }),
    getCredentialsDecrypted: vi.fn().mockResolvedValue({ email: 'api@x.com', password: 'pw' }),
    save: vi.fn().mockResolvedValue({ api_email: 'api@x.com', api_password_encrypted: 'enc' }),
    recordTest: vi.fn().mockResolvedValue({}),
    ...overrides,
  }
}

describe('ShiprocketService', () => {
  it('never returns the password and masks the email', async () => {
    const view = await new ShiprocketService(repo()).get()
    expect(view.email).toBe('ap••••@x.com')
    expect(view.hasPassword).toBe(true)
    expect(JSON.stringify(view)).not.toContain('enc')
  })

  it('test with stored credentials records the outcome', async () => {
    const r = repo()
    const client = {
      login: vi.fn().mockResolvedValue('t'),
      listPickupLocations: vi.fn().mockResolvedValue([{ pickup_location: 'Kolkata', city: 'Kolkata', pin_code: '700001' }]),
    }
    const res = await new ShiprocketService(r, () => client).test({}, 'admin')
    expect(res.success).toBe(true)
    expect(res.pickupLocations[0].name).toBe('Kolkata')
    expect(r.recordTest).toHaveBeenCalledWith({ status: 'SUCCESS', message: 'Connected to Shiprocket' }, 'admin')
  })

  it('warns clearly when the Shiprocket account has no pickup locations', async () => {
    const client = { login: vi.fn().mockResolvedValue('t'), listPickupLocations: vi.fn().mockResolvedValue([]) }
    const res = await new ShiprocketService(repo(), () => client).test({}, 'admin')
    expect(res.success).toBe(true)
    expect(res.message).toMatch(/NO pickup locations/)
  })

  it('a failed login is reported, not thrown', async () => {
    const r = repo()
    const client = { login: vi.fn().mockRejectedValue(new Error('Invalid credentials')), listPickupLocations: vi.fn() }
    const res = await new ShiprocketService(r, () => client).test({}, 'admin')
    expect(res).toMatchObject({ success: false, message: 'Invalid credentials' })
    expect(r.recordTest).toHaveBeenCalledWith({ status: 'FAILED', message: 'Invalid credentials' }, 'admin')
  })

  it('testing a draft does not overwrite the stored test result', async () => {
    const r = repo()
    const client = { login: vi.fn().mockResolvedValue('t'), listPickupLocations: vi.fn().mockResolvedValue([]) }
    await new ShiprocketService(r, () => client).test({ email: 'a@b.com', password: 'p' }, 'admin')
    expect(r.recordTest).not.toHaveBeenCalled()
  })

  it('save audits with the required target_type and never logs the password', async () => {
    const { emit } = await import('../../../src/utils/audit-log.js')
    await new ShiprocketService(repo()).save({ email: 'a@b.com', password: 'secret-pw' }, 'admin')
    const [action, payload] = emit.mock.calls.at(-1)
    expect(action).toBe('shiprocket_settings_updated')
    expect(payload.target_type).toBe('shiprocket_settings')
    expect(JSON.stringify(payload)).not.toContain('secret-pw')
  })

  it('rejects testing when nothing is saved', async () => {
    const r = repo({ getCredentialsDecrypted: vi.fn().mockResolvedValue(null) })
    await expect(new ShiprocketService(r).test({}, 'a')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('ShiprocketClient', () => {
  it('re-logs in once on a 401 and retries', async () => {
    let apiCalls = 0
    const urls = []
    const fetchImpl = vi.fn(async (url) => {
      urls.push(url)
      if (url.endsWith('/auth/login')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ token: `tok${urls.length}` }) }
      }
      apiCalls += 1
      if (apiCalls === 1) return { ok: false, status: 401, text: async () => '{"message":"expired"}' }
      return { ok: true, status: 200, text: async () => '{"ok":true}' }
    })
    const c = new ShiprocketClient({ email: 'a', password: 'b' }, fetchImpl)
    expect(await c.request('/x')).toEqual({ ok: true })
    expect(urls.filter((u) => u.endsWith('/auth/login')).length).toBe(2)
  })
})
