import { call, otpLogin, adminLogin, check, summary, PHONES, sleep, sampleImages, vendorIdOf, categoryId, ensureAddress } from './lib.mjs'
const A = await otpLogin(PHONES.vendorA), B = await otpLogin(PHONES.vendorB), cust = await otpLogin(PHONES.customer2), adm = await adminLogin()
const images = await sampleImages(); const cat = await categoryId()
console.log('--- customer wholesale price abuse')
const L = (await call(adm.token,'POST','/admin/listings',{ name:`QA-SEC wholesale ${Date.now().toString(36)}`, categoryId:cat, condition:'NEW', stock:50, price:1000, mrp:1200, images, ownerVendorId:vendorIdOf(A.token), brand:'QA', sellB2b:true, wholesalePrice:600, moq:5 })).data
await call(cust.token,'DELETE','/cart'); 
let r = await call(cust.token,'POST','/cart/items',{ shopProductId:L.id, quantity:5, priceMode:'wholesale' }); console.log('   add wholesale ->', r.status, r.json?.message, r.json?.code)
const cartW = await call(cust.token,'GET','/cart?priceMode=wholesale'); console.log('   wholesale cart subtotal', cartW.data?.subtotal, 'mode', cartW.data?.priceMode)
const addr = await ensureAddress(cust.token)
r = await call(cust.token,'POST','/orders',{ addressId:addr.id, paymentMethod:'COD', priceMode:'wholesale' }); console.log('   wholesale order ->', r.status, r.json?.message, JSON.stringify(r.data?.order?.items?.[0])?.slice(0,200), 'total', r.data?.order?.totalAmount)
check('customer cannot place a wholesale-priced order', r.status!==201, `order placed at ${r.data?.order?.totalAmount}`)
if (r.status===201) { await call(cust.token,'POST',`/orders/${r.data.order.id}/cancel`,{ reason:'QA cleanup' }) }
await call(cust.token,'DELETE','/cart'); await call(cust.token,'DELETE','/cart?priceMode=wholesale')
console.log('--- IDOR sweep: vendor B using vendor A ids')
const ids = {}
let q = await call(A.token,'GET','/vendor/listings?limit=1'); ids.listing = q.json.data?.[0]?.id
q = await call(A.token,'GET','/seller-orders?limit=1'); ids.so = q.json.data?.[0]?.id
q = await call(A.token,'GET','/manage/auctions?limit=1'); ids.auction = q.json.data?.[0]?.id
q = await call(A.token,'GET','/manage/ads?limit=1'); ids.ad = q.json.data?.[0]?.id
q = await call(A.token,'GET','/vendor/b2b/orders?role=selling&limit=1'); ids.b2bo = q.json.data?.[0]?.id
q = await call(A.token,'GET','/vendor/b2b/requirements?scope=quoted&limit=1'); ids.req = q.json.data?.[0]?.id
q = await call(A.token,'GET','/manage/sell-requests?limit=1'); ids.sell = q.data?.items?.[0]?.id
q = await call(A.token,'GET','/manage/abandoned-carts?limit=1'); ids.cart = q.json.data?.[0]?.id
console.log('   ids', JSON.stringify(ids))
const probes = [
  ['GET',`/vendor/listings/${ids.listing}`],['PATCH',`/vendor/listings/${ids.listing}`,{price:1}],['DELETE',`/vendor/listings/${ids.listing}`],
  ['GET',`/seller-orders/${ids.so}`],['POST',`/seller-orders/${ids.so}/status`,{status:'CANCELLED'}],
  ['GET',`/manage/auctions/${ids.auction}`],['PUT',`/manage/auctions/${ids.auction}`,{title:'hack'}],['POST',`/manage/auctions/${ids.auction}/cancel`,{}],
  ['GET',`/manage/ads/${ids.ad}`],['PUT',`/manage/ads/${ids.ad}`,{dailyBudget:500}],['POST',`/manage/ads/${ids.ad}/pause`],['GET',`/manage/ads/${ids.ad}/report`],
  ['GET',`/vendor/b2b/orders/${ids.b2bo}`],['POST',`/vendor/b2b/orders/${ids.b2bo}/cancel`,{reason:'hack hack'}],['POST',`/vendor/b2b/orders/${ids.b2bo}/receive`,{}],
  ['GET',`/manage/sell-requests/${ids.sell}`],['GET',`/manage/abandoned-carts/${ids.cart}`],['POST',`/manage/abandoned-carts/${ids.cart}/remind`,{templateKey:'GENTLE'}],
]
for (const [m,p,b] of probes) { if (p.includes('undefined')) { console.log('   skip', m, p); continue } const x = await call(B.token,m,p,b); check(`B → ${m} ${p.replace(/[0-9a-f-]{36}/,':id')} blocked (${x.status})`, [400,403,404,409,422].includes(x.status) && x.status!==200, JSON.stringify(x.json).slice(0,120)) }
console.log('--- header spoof: X-Vendor-Id on vendor token')
q = await call(B.token,'GET','/seller-orders?limit=3',undefined,{ 'x-vendor-id': vendorIdOf(A.token) }); check('X-Vendor-Id header ignored for vendor JWT', !(q.json.data||[]).some(x=>x.vendor_id===vendorIdOf(A.token)), 'leak')
q = await call(cust.token,'GET','/seller-orders?limit=3',undefined,{ 'x-vendor-id': vendorIdOf(A.token) }); check('X-Vendor-Id header ignored for customer', q.status===403, q.status)
console.log('--- admin-only routes with vendor/customer token')
for (const [m,p,b] of [['POST',`/admin/listings/${L.id}/approve`],['POST','/admin/settlements/vendors/'+vendorIdOf(B.token)+'/adjust',{amount:1,reason:'x'}],['GET','/admin/b2b/insights'],['PUT','/manage/auctions/settings',{enabled:false}],['PUT','/manage/ads/settings',{enabled:false}],['POST',`/wallet/admin/${A.user.id}/credit`,{amount:10}]]) {
  const x = await call(B.token,m,p,b); const y = await call(cust.token,m,p,b); check(`vendor+customer blocked: ${m} ${p.slice(0,45)} (${x.status}/${y.status})`, [401,403,404].includes(x.status) && [401,403,404].includes(y.status)) }
console.log('--- input fuzz')
for (const bad of ['<script>alert(1)</script>', "'; DROP TABLE users;--", '😀'.repeat(300), '\u0000', '${7*7}']) {
  const x = await call(A.token,'GET',`/vendor/listings?search=${encodeURIComponent(bad)}`); check(`search fuzz no 5xx (${bad.slice(0,12)}) → ${x.status}`, x.status<500)
  const y = await call(cust.token,'GET',`/discovery/search?q=${encodeURIComponent(bad)}`); check(`discovery fuzz no 5xx → ${y.status}`, y.status<500)
}
for (const n of [Number.MAX_SAFE_INTEGER, 1e308, -1e308, 0.0000001, '1e999', 'NaN']) { const x = await call(B.token,'POST','/settlements/transfer-to-wallet',{ amount:n }); check(`transfer amount ${String(n).slice(0,10)} → ${x.status}`, x.status>=400 && x.status<500) }
process.exit(summary()?1:0)
