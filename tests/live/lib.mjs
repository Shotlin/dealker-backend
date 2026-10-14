// Live-API test harness. Usage: node tests/live/<file>.mjs  (Node 20+)
// Actors log in via demo OTP (123456) / admin email+password. All created rows must be prefixed QA-.
export const API = process.env.API || 'https://api.dealker.agnixstudio.in/api/v1'
export const PHONES = {
  customer: '9000000001', admin: '9000000002', vendorA: '9000000003',
  vendorB: '9000000004', repair: '9000000005', customer2: '9000000006',
}
const ADMIN = { email: 'superadmin@dealker.local', password: 'SuperAdmin@123' }

export async function call(token, method, path, body, extra = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? (method === 'GET' || method === 'DELETE' ? undefined : '{}') : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json, data: json?.data }
}
export async function otpLogin(phone) {
  await call(null, 'POST', '/auth/send-otp', { phone })
  const r = await call(null, 'POST', '/auth/verify-otp', { phone, otp: '123456' })
  if (!r.data?.accessToken) throw new Error(`login ${phone} failed ${r.status} ${JSON.stringify(r.json)}`)
  return { token: r.data.accessToken, user: r.data.user, raw: r.data }
}
export async function adminLogin() {
  const r = await call(null, 'POST', '/admin/auth/login', ADMIN)
  if (!r.data?.accessToken) throw new Error('admin login failed ' + JSON.stringify(r.json))
  return { token: r.data.accessToken, user: r.data.user }
}
let pass = 0, fail = 0; const failures = []
export function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS', name) } else { fail++; failures.push(name); console.log('  FAIL', name, detail ? '→ ' + String(detail).slice(0, 300) : '') }
  return !!cond
}
export function summary() { console.log(`\n${pass} pass, ${fail} fail`); if (fail) console.log('FAILED:\n - ' + failures.join('\n - ')); return fail }
export const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export const QA = (s) => `QA-${s}-${Date.now().toString(36)}`
export async function sampleImages() {
  const r = await call(null, 'GET', '/discovery/search?limit=6')
  const imgs = (r.data || []).flatMap(p => p.images || [p.thumbnail]).filter(Boolean)
  return imgs.slice(0, 3)
}
export const vendorIdOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).vendorId
export async function categoryId() { return (await call(null, 'GET', '/categories')).data[0].id }
export async function ensureAddress(token) {
  const l = await call(token, 'GET', '/addresses')
  const hit = (l.data || []).find(a => a.label === 'QA Home')
  if (hit) return hit
  const r = await call(token, 'POST', '/addresses', { label: 'QA Home', addressLine1: 'QA 12 Test Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560034', lat: 12.9352, lng: 77.6245, isDefault: false })
  return r.data
}
