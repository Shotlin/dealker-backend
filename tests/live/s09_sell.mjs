import { call, otpLogin, adminLogin, check, summary, PHONES, sleep, ensureAddress } from './lib.mjs'
const A = await otpLogin(PHONES.vendorA), B = await otpLogin(PHONES.vendorB), cust = await otpLogin(PHONES.customer2), cust1 = await otpLogin(PHONES.customer), adm = await adminLogin()
const luhn = (n) => { let s = 0; const d = n.split('').reverse().map(Number); d.forEach((x,i)=>{ if (i%2===0) { x*=2; if (x>9) x-=9 } s+=x }); return (10 - s%10)%10 }
const mkImei = () => { const b = '35' + String(Math.floor(Math.random()*1e12)).padStart(12,'0'); return b + luhn('0'+b).toString() }
let imei = mkImei(); while (true) { let t=0; const d=imei.split('').reverse().map(Number); d.forEach((x,i)=>{ if (i%2===1){ x*=2; if(x>9)x-=9 } t+=x }); if (t%10===0) break; imei = mkImei() }
const cat = (await call(cust.token,'GET','/sell-requests/catalog')).data; const model = cat[0]
const qa = { ageMonths:12, screenScratches:'MINOR', bodyDents:false, screenReplaced:false, skinReplaced:false, billAvailable:true, boxAvailable:true, chargerAvailable:true, batteryHealth:88, powersOn:true }
const input = { type:'SELL_TO_AB', modelId:model.id, variant:model.variants[0], color:model.colors[0], qa, imei, description:'QA sell test', location:{ lat:12.9352, lng:77.6245, pincode:'560034' }, customer:{ city:'Bengaluru' } }
console.log('--- eligibility')
let r = await call(cust.token,'POST','/sell-requests/verify-imei',{ imei:'123456789012345' }); console.log('   bad luhn ->', r.status, JSON.stringify(r.json).slice(0,200))
r = await call(cust.token,'POST','/sell-requests/verify-imei',{ imei }); check('valid IMEI passes', r.status===200, JSON.stringify(r.json).slice(0,300)); const chk = r.data; console.log('   ', JSON.stringify(chk).slice(0,250))
r = await call(cust.token,'POST','/sell-requests/estimate',input); check('estimate band', r.status===200 && r.data?.estimateMax>=r.data?.estimateMin, JSON.stringify(r.json).slice(0,300)); console.log('   est', r.data?.estimateMin, r.data?.estimateMax, 'vendors nearby', r.data?.vendorsNearby)
r = await call(cust.token,'POST','/sell-requests',{ ...input, imei:'123456789012345' }); check('bad IMEI create rejected', r.status===422, r.status)
r = await call(cust.token,'POST','/sell-requests',{ ...input, qa:{ ...qa, batteryHealth:5 } }); check('battery 5 rejected', r.status===422, r.status)
r = await call(cust.token,'POST','/sell-requests',{ ...input, color:'Invisible' }); check('unknown colour rejected', r.status===422, r.status)
r = await call(cust.token,'POST','/exchange-requests',{ ...input }); check('sell payload on exchange endpoint rejected', r.status===422, r.status)
r = await call(null,'POST','/sell-requests',input); check('guest cannot create', r.status===401)
r = await call(cust.token,'POST','/sell-requests',{ ...input, imeiCheckId: chk?.checkId || chk?.id }); check('customer creates sell request', r.status===201, JSON.stringify(r.json).slice(0,400)); const SR = r.data; console.log('   ', SR?.id, SR?.code, SR?.status)
r = await call(cust.token,'POST','/sell-requests',{ ...input }); check('same IMEI twice (live request) rejected', r.status>=400, r.status+' '+r.json?.code)
console.log('--- visibility')
r = await call(A.token,'GET','/manage/sell-requests?status=pending&limit=50'); const seenA = (r.data?.items||[]).find(x=>x.id===SR.id); check('vendor A sees open request', !!seenA, JSON.stringify(r.json).slice(0,200)); console.log('   A view:', JSON.stringify(seenA)?.slice(0,300))
check('vendor view masks customer phone', !/9000000006/.test(JSON.stringify(seenA||{})), 'phone leaked')
r = await call(cust1.token,'GET',`/sell-requests/${SR.id}`); check("other customer can't read", [403,404].includes(r.status), r.status)
r = await call(cust1.token,'GET','/sell-requests/mine'); check("other customer's list excludes", !JSON.stringify(r.json).includes(SR.id))
console.log('--- offers')
r = await call(A.token,'POST',`/manage/sell-requests/${SR.id}/offers`,{ amount:-5 }); check('negative offer rejected', r.status===422, r.status)
r = await call(A.token,'POST',`/manage/sell-requests/${SR.id}/offers`,{ amount:99999999 }); check('absurd offer rejected', r.status===422, r.status)
const base = Number(SR?.basePrice ?? SR?.base_price ?? model.basePrice)
r = await call(A.token,'POST',`/manage/sell-requests/${SR.id}/offers`,{ amount: Math.round(base*0.7), note:'QA A offer' }); check('A offers', r.status===200, JSON.stringify(r.json).slice(0,300))
r = await call(B.token,'POST',`/manage/sell-requests/${SR.id}/offers`,{ amount: Math.round(base*0.6), note:'QA B offer' }); check('B offers', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(cust.token,'POST',`/manage/sell-requests/${SR.id}/offers`,{ amount: 100 }); check('customer cannot offer', r.status===403, r.status)
r = await call(cust.token,'GET',`/sell-requests/${SR.id}/offers`); const offers = r.data?.offers||r.data||[]; console.log('   customer sees offers', offers.length, JSON.stringify(offers[0])?.slice(0,250)); check('customer sees 2 offers', offers.length===2)
check('offers show named buyers, no vendor phone', !/9000000003|9000000004/.test(JSON.stringify(r.json)))
const best = offers.find(o=>o.best) || offers[0]
r = await call(cust1.token,'POST',`/sell-requests/${SR.id}/offers/${best?.id}/accept`); check('other customer cannot accept', r.status>=400, r.status)
r = await call(cust.token,'POST',`/sell-requests/${SR.id}/offers/${best?.id}/accept`); check('customer accepts best', r.status===200, JSON.stringify(r.json).slice(0,300))
r = await call(cust.token,'POST',`/sell-requests/${SR.id}/offers/${offers.find(o=>o.id!==best?.id)?.id}/accept`); check('cannot accept a second offer', r.status>=400, r.status)
const winner = JSON.stringify(best).includes('QA Vendor B') ? B : A; const loser = winner===A?B:A
r = await call(loser.token,'GET',`/manage/sell-requests/${SR.id}`); console.log('   losing vendor can still open? ->', r.status)
r = await call(cust.token,'GET',`/sell-requests/${SR.id}/journey`); console.log('   journey stage', r.data?.stage, 'next', r.data?.nextAction)
console.log('--- fulfilment & funding')
r = await call(cust.token,'POST',`/sell-requests/${SR.id}/fulfilment`,{ fulfilment:'PICKUP', addressId:(await ensureAddress(cust.token)).id, date:new Date(Date.now()+864e5).toISOString().slice(0,10), window:'9 AM - 12 PM' }); check('customer books pickup', r.status===200, JSON.stringify(r.json).slice(0,300))
r = await call(winner.token,'POST',`/manage/sell-requests/${SR.id}/pickup`,{ provider:'SELF', awb:'QA1', courierName:'QA' }); check('pickup blocked until buyer funds', r.status>=400, r.status+' '+r.json?.code)
r = await call(loser.token,'POST',`/manage/sell-requests/${SR.id}/vendor-payment`,{ method:'UPI', reference:'QAUTR000001', idempotencyKey:'qa-fund-'+Date.now() }); check('non-assigned vendor cannot fund', r.status>=400, r.status)
r = await call(winner.token,'POST',`/manage/sell-requests/${SR.id}/vendor-payment`,{ method:'UPI', reference:'QAUTR000002', idempotencyKey:'qa-fund-'+Date.now() }); check('buyer submits funding ref', r.status===200, JSON.stringify(r.json).slice(0,300))
r = await call(winner.token,'POST',`/manage/sell-requests/${SR.id}/vendor-payment/confirm`,{}); check('vendor cannot confirm own payment', r.status===403, r.status)
r = await call(adm.token,'POST',`/manage/sell-requests/${SR.id}/vendor-payment/confirm`,{}); check('finance confirms → HELD', r.status===200, JSON.stringify(r.json).slice(0,300))
console.log('--- pickup → receive → inspection → payout')
const stepV = async (p, b={}, label) => { const x = await call(winner.token,'POST',`/manage/sell-requests/${SR.id}/${p}`,b); check(label||p, x.status===200, x.status+' '+JSON.stringify(x.json).slice(0,250)); return x }
await stepV('pickup',{ provider:'SELF', awb:'QA-AWB-1', courierName:'QA Courier' }); await stepV('pickup/status',{ status:'PICKED_UP' },'pickup status PICKED_UP'); await stepV('pickup/status',{ status:'IN_TRANSIT' },'pickup status IN_TRANSIT'); await stepV('received')
r = await call(winner.token,'GET',`/manage/sell-requests/${SR.id}/qc`); console.log('   qc', r.status, JSON.stringify(r.json).slice(0,300))
r = await call(cust.token,'GET',`/sell-requests/${SR.id}/journey`); console.log('   journey', r.data?.stage, r.data?.nextAction, JSON.stringify(r.data?.inspection)?.slice(0,200))
console.log('IDS', JSON.stringify({ SR: SR.id, winner: winner===A?'A':'B', imei }))
process.exit(summary()?1:0)
