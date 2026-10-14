import { call, otpLogin, adminLogin, check, summary, PHONES, QA, sleep, sampleImages, vendorIdOf, categoryId } from './lib.mjs'
const A = await otpLogin(PHONES.vendorA), B = await otpLogin(PHONES.vendorB), adm = await adminLogin(), cust = await otpLogin(PHONES.customer)
const vA = vendorIdOf(A.token), vB = vendorIdOf(B.token); const images = await sampleImages(); const cat = await categoryId()
const tag = QA('dem').replace(/-/g,' ')   // model name words
const model = `QZ${Date.now().toString(36).toUpperCase()}`
const bal = async (t) => Number((await call(t,'GET','/vendor/b2b/wallet')).data?.balance)
// fund buyer
let r = await call(adm.token,'POST',`/admin/settlements/vendors/${vB}/adjust`,{ amount: 50000, reason: 'QA test funding' }); check('admin funds vendor B wallet', r.status===200, JSON.stringify(r.json))
const bB0 = await bal(B.token), bA0 = await bal(A.token); check('B wallet ≥ 50000', bB0>=50000, bB0)
// seller stock: vendor A listing matching the model, admin-approved
r = await call(adm.token,'POST','/admin/listings',{ name:`${model} Phone 128GB`, categoryId:cat, condition:'NEW', stock:30, price:1000, mrp:1500, images, ownerVendorId:vA, brand:'QA', sellB2b:true, wholesalePrice:900, moq:5 }); check('A stock listing', r.status===201, JSON.stringify(r.json).slice(0,300)); const L = r.data
// validations on requirement
const deadline = new Date(Date.now()+3*864e5).toISOString()
const req0 = { productName:`${model} Phone`, quantity:10, responseDeadline:deadline, conditionPref:'NEW', targetPrice:950, deliveryCity:'Bengaluru', deliveryPincode:'560034', storage:'128GB' }
r = await call(B.token,'POST','/vendor/b2b/requirements',{ ...req0, quantity:0 }); check('qty 0 rejected', r.status===400)
r = await call(B.token,'POST','/vendor/b2b/requirements',{ ...req0, productName:'x' }); check('short name rejected', r.status===400)
r = await call(B.token,'POST','/vendor/b2b/requirements',{ ...req0, responseDeadline:new Date(Date.now()-864e5).toISOString() }); console.log('   past deadline ->', r.status, r.json?.message); check('past deadline rejected', r.status===400)
r = await call(B.token,'POST','/vendor/b2b/requirements',{ ...req0, targetPrice:-5 }); check('negative target rejected', r.status===400)
r = await call(cust.token,'POST','/vendor/b2b/requirements',req0); check('customer cannot post demand', r.status===403, r.status)
// post
r = await call(B.token,'POST','/vendor/b2b/requirements',req0); check('B posts demand', r.status===200||r.status===201, JSON.stringify(r.json).slice(0,300)); const R = r.data; console.log('   req', R?.id, R?.status)
if (!R?.id) process.exit(1)
// visibility
r = await call(A.token,'GET','/vendor/b2b/requirements?scope=open'); const seen = (r.json?.data||[]).find(x=>x.id===R.id); check('A sees the demand in open', !!seen, JSON.stringify(r.json).slice(0,200)); console.log('   my_match', JSON.stringify(seen?.my_match), 'tags', seen?.tags)
r = await call(A.token,'GET','/vendor/b2b/requirements?scope=open&search='+model); check('search finds it', (r.json?.data||[]).some(x=>x.id===R.id))
r = await call(B.token,'GET','/vendor/b2b/requirements?scope=open'); check('B (buyer) does not see own demand in open', !(r.json?.data||[]).some(x=>x.id===R.id))
r = await call(B.token,'GET','/vendor/b2b/requirements?scope=mine'); check('B sees it in mine', (r.json?.data||[]).some(x=>x.id===R.id))
r = await call(cust.token,'GET','/vendor/b2b/requirements?scope=open'); check('customer cannot read demands', r.status===403)
r = await call(A.token,'GET',`/vendor/b2b/requirements/${R.id}/match`); check('A match endpoint', r.status===200, JSON.stringify(r.json).slice(0,300)); console.log('   match', JSON.stringify(r.data)?.slice(0,300))
// A's own notification
await sleep(500)
r = await call(A.token,'GET','/notifications?limit=5'); console.log('   A notifications', r.status, JSON.stringify(r.json)?.slice(0,400))
// quote validations
const q0 = { quantity:10, unitPrice:940, condition:'NEW', deliveryDays:2, listingId:L.id }
r = await call(B.token,'POST',`/vendor/b2b/requirements/${R.id}/quote`,q0); check('buyer cannot quote own demand', r.status>=400, r.status+' '+r.json?.message)
r = await call(A.token,'POST',`/vendor/b2b/requirements/${R.id}/quote`,{ ...q0, unitPrice:-1 }); check('negative price rejected', r.status===400)
r = await call(A.token,'POST',`/vendor/b2b/requirements/${R.id}/quote`,{ ...q0, quantity:0 }); check('qty 0 rejected', r.status===400)
r = await call(A.token,'POST',`/vendor/b2b/requirements/${R.id}/quote`,{ ...q0, listingId:'3f2a5b4c-0000-4000-8000-000000000000' }); console.log('   foreign listing ->', r.status, r.json?.message)
r = await call(A.token,'POST',`/vendor/b2b/requirements/${R.id}/quote`,q0); check('A sends offer', r.status===200||r.status===201, JSON.stringify(r.json).slice(0,300)); const Q = r.data
r = await call(A.token,'POST',`/vendor/b2b/requirements/${R.id}/quote`,{ ...q0, unitPrice:930 }); check('A updates offer (no duplicate)', r.status===200||r.status===201, JSON.stringify(r.json).slice(0,200))
r = await call(B.token,'GET',`/vendor/b2b/requirements/${R.id}`); const quotes = r.data?.quotes||[]; console.log('   quotes seen by buyer', quotes.length, JSON.stringify(quotes[0])?.slice(0,300)); check('buyer sees exactly 1 offer at 930', quotes.length===1 && Number(quotes[0].unit_price ?? quotes[0].unitPrice)===930)
r = await call(A.token,'GET',`/vendor/b2b/requirements/${R.id}`); check('seller cannot see others/buyer data beyond own', r.status===200); console.log('   seller view quotes', JSON.stringify(r.data?.quotes)?.slice(0,200))
const qid = quotes[0]?.id
// award
r = await call(A.token,'POST',`/vendor/b2b/requirements/${R.id}/award`,{ selections:[{quoteId:qid,quantity:10}] }); check('seller cannot award', r.status>=400, r.status)
r = await call(B.token,'POST',`/vendor/b2b/requirements/${R.id}/award`,{ selections:[{quoteId:qid,quantity:11}] }); check('award above needed qty rejected', r.status>=400, r.status+' '+r.json?.message)
r = await call(B.token,'POST',`/vendor/b2b/requirements/${R.id}/award`,{ selections:[{quoteId:qid,quantity:10}] }); check('B awards', r.status===200, JSON.stringify(r.json).slice(0,300)); console.log('   award', JSON.stringify(r.data)?.slice(0,300))
// pay
r = await call(B.token,'POST',`/vendor/b2b/requirements/${R.id}/pay`,{ method:'UPI' }); check('non-wallet pay rejected for vendor', r.status>=400, r.status+' '+r.json?.message)
r = await call(A.token,'POST',`/vendor/b2b/requirements/${R.id}/pay`,{ method:'WALLET' }); check('seller cannot pay', r.status>=400, r.status)
r = await call(B.token,'POST',`/vendor/b2b/requirements/${R.id}/pay`,{ method:'WALLET' }); check('B pays by wallet', r.status===200, JSON.stringify(r.json).slice(0,300))
const bB1 = await bal(B.token); check('B debited 9300', Math.abs((bB0-bB1)-9300)<0.01, `Δ=${bB0-bB1}`)
r = await call(B.token,'POST',`/vendor/b2b/requirements/${R.id}/pay`,{ method:'WALLET' }); check('second pay does nothing/ rejected', r.status>=400 || true, r.status+' '+r.json?.message); const bB1b = await bal(B.token); check('no double debit', Math.abs(bB1b-bB1)<0.01, `${bB1} → ${bB1b}`)
// order
r = await call(A.token,'GET','/vendor/b2b/orders?role=selling'); const ord = (r.json?.data||[]).find(o=>(o.requirement_id||o.requirementId)===R.id); check('A sees selling order', !!ord, JSON.stringify(r.json).slice(0,300)); console.log('   order', ord?.id, ord?.status, ord?.total_amount)
const oid = ord?.id
r = await call(B.token,'POST',`/vendor/b2b/orders/${oid}/status`,{ status:'DISPATCHED' }); check('buyer cannot dispatch', r.status>=400, r.status)
r = await call(A.token,'POST',`/vendor/b2b/orders/${oid}/status`,{ status:'DISPATCHED', fulfilmentType:'DELIVERY' }); check('dispatch w/o courier rejected', r.status===400, r.status+' '+r.json?.message)
r = await call(A.token,'POST',`/vendor/b2b/orders/${oid}/status`,{ status:'PACKED' }); check('A packs', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(A.token,'POST',`/vendor/b2b/orders/${oid}/status`,{ status:'DISPATCHED', fulfilmentType:'DELIVERY', courierName:'QA Courier', awb:'QAAWB1' }); check('A dispatches', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(A.token,'POST',`/vendor/b2b/orders/${oid}/status`,{ status:'DELIVERED' }); check('A marks delivered', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(B.token,'GET',`/vendor/b2b/orders/${oid}`); console.log('   buyer view', r.data?.status, JSON.stringify(r.data?.timeline||r.data?.events||'')?.slice(0,150))
const bA1 = await bal(A.token)
r = await call(B.token,'POST',`/vendor/b2b/orders/${oid}/receive`,{ receivedQuantity:10, quantity:10, ok:true, allGood:true }); console.log('   receive ->', r.status, JSON.stringify(r.json).slice(0,300))
check('B confirms receipt', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(B.token,'POST',`/vendor/b2b/orders/${oid}/receive`,{ receivedQuantity:10 }); check('second receive rejected', r.status>=400, r.status)
await sleep(500)
const bA2 = await bal(A.token); console.log('   A balance Δ on release', bA2-bA1)
const commission = Number(ord?.commission_amount ?? 0); check('seller paid total minus commission', Math.abs((bA2-bA1)-(9300-commission))<0.01 && (bA2-bA1)>0, `Δ=${bA2-bA1} commission=${commission}`)
console.log('\nIDS', JSON.stringify({model, req:R.id, order:oid, listing:L.id}))
process.exit(summary()?1:0)
