import { call, otpLogin, check, summary, PHONES } from './lib.mjs'
const A = await otpLogin(PHONES.vendorA), B = await otpLogin(PHONES.vendorB), cust = await otpLogin(PHONES.customer2)
let r = await call(A.token,'GET','/manage/abandoned-carts/summary'); check('A summary', r.status===200, JSON.stringify(r.json).slice(0,300)); console.log('   ', JSON.stringify(r.data))
r = await call(A.token,'GET','/manage/abandoned-carts?limit=50'); check('A list', r.status===200); const rows = r.json?.data||[]; console.log('   rows', rows.length, JSON.stringify(rows[0])?.slice(0,500))
check('names masked', !rows.some(x=>/^\d{10}$/.test(x.customer_phone||'')) , JSON.stringify(rows[0]).slice(0,200))
r = await call(B.token,'GET','/manage/abandoned-carts?limit=50'); check('B sees none of A carts', !(r.json?.data||[]).some(x=>rows.some(y=>y.id===x.id)))
if (rows[0]) {
  const id = rows[0].id
  r = await call(B.token,'GET',`/manage/abandoned-carts/${id}`); check('B cannot open A cart', [403,404].includes(r.status), r.status)
  r = await call(B.token,'POST',`/manage/abandoned-carts/${id}/remind`,{ templateKey:'GENTLE' }); check('B cannot remind A cart', [403,404].includes(r.status), r.status)
  r = await call(cust.token,'GET',`/manage/abandoned-carts/${id}`); check('customer blocked', r.status===403, r.status)
  r = await call(A.token,'GET',`/manage/abandoned-carts/${id}`); check('A detail', r.status===200); console.log('   detail keys', Object.keys(r.data||{}).join(','))
  r = await call(A.token,'GET',`/manage/abandoned-carts/${id}/preview?templateKey=GENTLE`); console.log('   preview', r.status, JSON.stringify(r.json).slice(0,300))
  r = await call(A.token,'POST',`/manage/abandoned-carts/${id}/remind`,{ templateKey:'NOPE' }); check('unknown template rejected', r.status>=400, r.status)
}
r = await call(null,'GET','/manage/abandoned-carts'); check('unauth blocked', r.status===401)
process.exit(summary()?1:0)
