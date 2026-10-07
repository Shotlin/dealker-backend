import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'

vi.mock('../../../src/config/redis.js', () => ({ redis: {} }))
vi.mock('../../../src/config/env.js', () => ({ env: {} }))

import { otpRateLimit } from '../../../src/modules/auth/otp-rate-limit.js'
import { validatePhone } from '../../../src/middlewares/validatePhone.js'

const DEMO = '9700000001'
const service = { _isDemoOtpPhone: (p) => p === DEMO }

async function buildApp() {
  const app = Fastify()
  await app.register(rateLimit, { global: false, hook: 'onRequest' })
  app.post(
    '/send-otp',
    { preHandler: [validatePhone], config: { rateLimit: otpRateLimit(service, 5) } },
    async () => ({ ok: true }),
  )
  await app.ready()
  return app
}

const send = (app, phone, ip = '10.0.0.1') =>
  app.inject({
    method: 'POST',
    url: '/send-otp',
    remoteAddress: ip,
    payload: { phone },
  })

describe('otpRateLimit', () => {
  it('still limits a normal phone per IP (5 then 429)', async () => {
    const app = await buildApp()
    for (let i = 0; i < 5; i++) expect((await send(app, '9811111111')).statusCode).toBe(200)
    expect((await send(app, '9811111111')).statusCode).toBe(429)
  })

  it('does not limit a demo-OTP phone at the normal ceiling', async () => {
    const app = await buildApp()
    for (let i = 0; i < 20; i++) expect((await send(app, DEMO)).statusCode).toBe(200)
  })

  it('demo phone requests do not consume — or get blocked by — the shared IP bucket', async () => {
    const app = await buildApp()
    for (let i = 0; i < 5; i++) await send(app, '9822222222')
    expect((await send(app, '9822222222')).statusCode).toBe(429) // IP exhausted
    expect((await send(app, DEMO)).statusCode).toBe(200) // demo phone unaffected
  })

  it('normalises +91 prefix before deciding it is a demo phone', async () => {
    const app = await buildApp()
    for (let i = 0; i < 10; i++) expect((await send(app, `+91${DEMO}`)).statusCode).toBe(200)
  })
})
