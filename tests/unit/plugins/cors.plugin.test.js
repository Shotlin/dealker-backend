import { describe, expect, it } from 'vitest'
import Fastify from 'fastify'

import corsPlugin from '../../../src/plugins/cors.plugin.js'

async function buildApp() {
  const app = Fastify()
  await app.register(corsPlugin)
  app.get('/health', async () => ({ ok: true }))
  await app.ready()
  return app
}

describe('cors.plugin', () => {
  it('allows the production dashboard origin through preflight', async () => {
    const app = await buildApp()
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://dash.fc.opslin.com',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, content-type',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('https://dash.fc.opslin.com')
    expect(response.headers['access-control-allow-credentials']).toBe('true')
    await app.close()
  })
})
