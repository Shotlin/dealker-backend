import * as svc from './ola-maps.service.js'
import { success, error } from '../../utils/apiResponse.js'

const num = (v) => (v === undefined || v === '' ? NaN : Number(v))

/** Admin — prefix /api/v1/admin/ola-maps-settings (same coarse admin gate as razorpay/wallet settings). */
export async function olaMapsAdminRoutes(fastify) {
  const pre = [fastify.authenticate, fastify.requireAdmin]
  fastify.get('/', { preHandler: pre }, async (_req, reply) => reply.send(success(await svc.getAdminSettings(), 'Ola Maps settings fetched')))
  fastify.post('/test', { preHandler: pre }, async (req, reply) => {
    const key = String(req.body?.apiKey ?? '').trim()
    if (!key) return reply.code(400).send(error('apiKey is required', 'VALIDATION'))
    return reply.send(success(await svc.testKey(key), 'Test complete'))
  })
  fastify.put('/', { preHandler: pre }, async (req, reply) => {
    const { apiKey, isEnabled } = req.body || {}
    if (apiKey !== undefined && typeof apiKey !== 'string') return reply.code(400).send(error('apiKey must be a string', 'VALIDATION'))
    if (isEnabled !== undefined && typeof isEnabled !== 'boolean') return reply.code(400).send(error('isEnabled must be true or false', 'VALIDATION'))
    return reply.send(success(await svc.saveSettings({ apiKey, isEnabled }, req.user?.id), 'Ola Maps settings saved'))
  })
}

/** Public proxy for the apps — prefix /api/v1/maps/ola. Rate limited per IP; the key never leaves the server. */
export async function olaMapsPublicRoutes(fastify) {
  const limit = { rateLimit: { max: 60, timeWindow: '1 minute' } }
  // Never answer 502/503/504: the app counts those as "server down" and shows its full-screen
  // "Service unavailable" blocker. A maps problem just means "no results" (the app already handles that).
  const empty = { geocodingResults: [], results: [], points: [] }
  const wrap = (fn) => async (req, reply) => {
    try {
      return reply.send(success(await fn(req), 'OK'))
    } catch (err) {
      if (err.statusCode === 400) return reply.code(400).send(error('Invalid coordinates', 'VALIDATION'))
      const notConfigured = err instanceof svc.OlaNotConfigured
      return reply.send(success({ configured: !notConfigured, upstreamError: !notConfigured, result: empty }, 'Maps unavailable'))
    }
  }
  fastify.get('/style-url', { config: limit }, wrap(() => svc.styleUrl()))
  fastify.get('/geocode', { config: limit }, wrap(async (req) => {
    const address = String(req.query.address || '').trim().slice(0, 200)
    if (!address) return { result: { geocodingResults: [] } }
    return { result: await svc.geocode(address) }
  }))
  fastify.get('/reverse-geocode', { config: limit }, wrap(async (req) => {
    const lat = num(req.query.lat), lng = num(req.query.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw Object.assign(new Error('bad'), { statusCode: 400 })
    return { result: await svc.reverseGeocode(lat, lng) }
  }))
  fastify.get('/directions', { config: limit }, wrap(async (req) => {
    const q = req.query
    const o = { lat: num(q.originLat), lng: num(q.originLng) }, d = { lat: num(q.destLat), lng: num(q.destLng) }
    if (![o.lat, o.lng, d.lat, d.lng].every(Number.isFinite)) throw Object.assign(new Error('bad'), { statusCode: 400 })
    return { result: await svc.directions(o, d) }
  }))
}
