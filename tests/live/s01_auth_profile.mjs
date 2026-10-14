import { call, otpLogin, adminLogin, check, summary, PHONES } from './lib.mjs'
const c = await otpLogin(PHONES.customer), a = await adminLogin(), v = await otpLogin(PHONES.vendorA)
console.log('1.1 OTP')
check('customer login', !!c.token)
check('wrong OTP rejected', (await call(null,'POST','/auth/verify-otp',{phone:PHONES.customer,otp:'000000'})).status >= 400)
check('missing phone rejected', (await call(null,'POST','/auth/send-otp',{})).status === 400)
check('invalid phone rejected', (await call(null,'POST','/auth/send-otp',{phone:'abc'})).status >= 400)
console.log('1.2 JWT claims')
const dec = t => JSON.parse(Buffer.from(t.split('.')[1],'base64url'))
check('vendor jwt has vendorId', !!dec(v.token).vendorId)
check('customer jwt has no vendorId', !dec(c.token).vendorId)
console.log('1.2b customer token on vendor routes')
for (const p of ['/seller-orders','/vendor/listings','/manage/auctions','/manage/ads','/settlements/summary','/vendor/b2b/requirements','/manage/sell-requests','/manage/repairs/market/incoming']) {
  const r = await call(c.token,'GET',p); check(`customer blocked ${p} (${r.status})`, [401,403,404].includes(r.status))
  const u = await call(null,'GET',p); check(`unauth blocked ${p} (${u.status})`, u.status===401)
}
console.log('1.4 profile')
const vid = dec(v.token).vendorId
const prof = await call(v.token,'GET',`/vendors/${vid}`); check('vendor profile 200', prof.status===200, JSON.stringify(prof.json).slice(0,200)); console.log('   ', JSON.stringify(prof.data).slice(0,300))
const sub = await call(v.token,'GET','/subscriptions/me'); check('subscription 200', sub.status===200); console.log('   ', JSON.stringify(sub.data).slice(0,300))
const st = await call(v.token,'GET','/vendor/listings/stats'); check('listing stats 200', st.status===200); console.log('   ', JSON.stringify(st.data))
process.exit(summary()?1:0)
