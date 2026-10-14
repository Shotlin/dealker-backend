import { call, otpLogin, adminLogin, check, summary, PHONES } from './lib.mjs'
const B = await otpLogin(PHONES.vendorB), cust = await otpLogin(PHONES.customer2), adm = await adminLogin()
const imei = (() => { for (;;) { const b='35'+String(Math.floor(Math.random()*1e12)).padStart(12,'0'); for (let c=0;c<10;c++){ const n=b+c; let t=0; n.split('').reverse().forEach((d,i)=>{ let x=+d; if(i%2===1){x*=2; if(x>9)x-=9} t+=x }); if(t%10===0) return n } } })()
const m = (await call(cust.token,'GET','/exchange-requests/catalog')).data[0]
const qa = { ageMonths:10, screenScratches:'NONE', bodyDents:false, screenReplaced:false, skinReplaced:false, billAvailable:true, boxAvailable:true, chargerAvailable:true, batteryHealth:90, powersOn:true }
let r = await call(cust.token,'POST','/exchange-requests',{ type:'EXCHANGE', modelId:m.id, variant:m.variants[0], color:m.colors[0], qa, imei, exchange:{ newProduct:'QA New Phone', newProductPrice:50000 } }); const EX = r.data; check('exchange created', r.status===201)
const ord = ((await call(cust.token,'GET','/orders?limit=10')).json.data||[]).find(o=>o.status!=='CANCELLED')
r = await call(B.token,'POST',`/manage/exchange-requests/${EX.id}/offers`,{ amount: Math.round(Number(EX.quote ?? 20000)*0.8), note:'QA' }); check('vendor B offers', r.status===200, r.status+' '+JSON.stringify(r.json).slice(0,200))
r = await call(B.token,'POST',`/manage/exchange-requests/${EX.id}/approve`); check('vendor cannot approve', r.status===403, r.status)
r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/assign-vendor`,{ vendorId: JSON.parse(Buffer.from(B.token.split('.')[1],'base64url')).vendorId }); check('admin assigns vendor', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/approve`); check('approve', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/complete`); check('complete blocked until order linked', r.status>=400, r.status)
const cands = ((await call(cust.token,'GET','/orders?limit=30')).json.data||[]).filter(o=>o.status!=='CANCELLED'); let linked=false; for (const c of cands) { r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/link-order`,{ orderNumber:c.order_number }); if (r.status===200) { linked=true; break } else if (r.json?.code!=='ORDER_ALREADY_LINKED') console.log('   link', c.order_number, r.status, r.json?.code) }
check('link an unlinked own order (one order per trade-in enforced)', linked)
r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/complete`); check('complete', r.status===200, r.status+' '+JSON.stringify(r.json).slice(0,200))
r = await call(cust.token,'POST',`/exchange-requests/${EX.id}/cancel`,{ reason:'x' }); check('completed exchange cannot be cancelled', r.status>=400, r.status)
process.exit(summary()?1:0)
