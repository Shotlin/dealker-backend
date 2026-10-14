import { call, otpLogin, adminLogin, check, summary, PHONES, sleep } from './lib.mjs'
const A = await otpLogin(PHONES.vendorA), c2all = [await otpLogin(PHONES.customer2), await otpLogin(PHONES.repair)], adm = await adminLogin()
const orders = (await call(adm.token,'GET','/admin/orders?page=1&limit=30')).data.orders
// only QA rows: QA customer 2's wallet-paid orders whose items are all QA-*
const paid = orders.find(o=>c2all.some(c=>c.user.id===o.customer_id) && o.payment_status==='PAID' && o.status==='ORDER_PLACED' && Number(o.wallet_amount)>0 && (o.items||[]).every(i=>/^QA-/.test(i.name||'')))
if (!paid) { console.log('no QA wallet-paid order found'); process.exit(2) }
console.log('   target', paid.order_number, 'wallet', paid.wallet_amount)
const c2 = c2all.find(c=>c.user.id===paid.customer_id)
const w0 = Number((await call(c2.token,'GET','/wallet')).data.balance)
const so = (await call(A.token,'GET',`/seller-orders?orderId=${paid.id}`)).json.data[0]
const r = await call(A.token,'POST',`/seller-orders/${so.id}/status`,{ status:'CANCELLED', reason:'QA prepaid cancel' }); check('vendor cancels wallet-paid QA order', r.status===200, JSON.stringify(r.json).slice(0,200)); console.log('   flags', r.data?.parent_cancelled, r.data?.refund_required)
await sleep(800)
const w1 = Number((await call(c2.token,'GET','/wallet')).data.balance)
console.log('   customer wallet', w0, '→', w1)
check('customer gets the wallet amount back', w1-w0 >= Number(paid.wallet_amount)-0.01, `Δ=${w1-w0}`)
process.exit(summary()?1:0)
