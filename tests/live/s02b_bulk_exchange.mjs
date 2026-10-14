import { call, otpLogin, adminLogin, check, summary, PHONES, sleep, sampleImages, categoryId, ensureAddress } from './lib.mjs'
const B = await otpLogin(PHONES.vendorB), cust = await otpLogin(PHONES.customer2), adm = await adminLogin()
const images = await sampleImages(); const cat = await categoryId()
console.log('--- bulk add: one model × variants (client posts one listing per variant)')
const model = 'QA-BULK Phone ' + Date.now().toString(36)
const variants = [{ v:'64GB', p:10000 },{ v:'128GB', p:12000 },{ v:'256GB', p:-1 },{ v:'512GB', p:18000 }]
const out = []
for (const x of variants) out.push(await call(B.token,'POST','/vendor/listings',{ name:`${model} ${x.v}`, categoryId:cat, condition:'NEW', stock:10, price:x.p, mrp:Math.max(x.p,0)+1000, images, brand:'QA', sellB2c:true, sellB2b:true, wholesalePrice:Math.max(x.p-500,1), moq:2 }))
console.log('   statuses', out.map(o=>o.status).join(','))
check('valid variants created, invalid one rejected alone', out.map(o=>o.status).join(',')==='201,201,400,201')
const list = await call(B.token,'GET',`/vendor/listings?search=${encodeURIComponent(model)}`); check('3 listings visible, all PENDING', (list.json.data||[]).length===3 && list.json.data.every(l=>l.approval_status==='PENDING'), JSON.stringify((list.json.data||[]).map(l=>l.approval_status)))
for (const l of list.json.data||[]) await call(B.token,'DELETE',`/vendor/listings/${l.id}`)
console.log('--- exchange request (trade-in with new-phone order)')
const luhnImei = () => { for (;;) { const b='35'+String(Math.floor(Math.random()*1e12)).padStart(12,'0'); for (let c=0;c<10;c++){ const n=b+c; let t=0; n.split('').reverse().forEach((d,i)=>{ let x=+d; if(i%2===1){x*=2; if(x>9)x-=9} t+=x }); if(t%10===0) return n } } }
const catalog = (await call(cust.token,'GET','/exchange-requests/catalog')).data; check('exchange catalogue available', catalog?.length>0, JSON.stringify(catalog).slice(0,80))
const m = catalog[0]; const qa = { ageMonths:10, screenScratches:'NONE', bodyDents:false, screenReplaced:false, skinReplaced:false, billAvailable:true, boxAvailable:true, chargerAvailable:true, batteryHealth:90, powersOn:true }
const body = { type:'EXCHANGE', modelId:m.id, variant:m.variants[0], color:m.colors[0], qa, imei:luhnImei(), description:'QA exchange', exchange:{ newProduct:'QA New Phone', newProductPrice:50000 } }
let r = await call(cust.token,'POST','/exchange-requests',{ ...body, exchange:{ newProduct:'', newProductPrice:0 } }); check('exchange needs new product + price', r.status===422, r.status)
r = await call(cust.token,'POST','/sell-requests',body); check('exchange payload on sell endpoint rejected', r.status===422, r.status)
r = await call(cust.token,'POST','/exchange-requests',body); check('customer creates exchange', r.status===201, JSON.stringify(r.json).slice(0,300)); const EX = r.data; console.log('   ', EX?.id, EX?.code, EX?.status)
check('code is EXCH-', /^EXCH-/.test(EX?.code||''))
r = await call(cust.token,'GET',`/sell-requests/${EX.id}`); check('exchange not readable via sell section', [403,404].includes(r.status), r.status)
r = await call(adm.token,'GET',`/manage/sell-requests/${EX.id}`); check('admin sell section cannot read exchange row', r.status===404, r.status)
r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/approve`); check('approve', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/complete`); check('cannot complete without linked order', r.status>=400, r.status+' '+r.json?.message)
r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/link-order`,{ orderNumber:'MK-DOES-NOT-EXIST' }); check('unknown order cannot be linked', r.status>=400, r.status)
const orders = await call(cust.token,'GET','/orders?limit=5'); const ord = (orders.json.data||[]).find(o=>o.status!=='CANCELLED'); console.log('   link candidate', ord?.order_number)
if (ord) { r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/link-order`,{ orderNumber:ord.order_number }); check('link own order', r.status===200, r.status+' '+JSON.stringify(r.json).slice(0,200)); r = await call(adm.token,'POST',`/manage/exchange-requests/${EX.id}/complete`); check('complete after link', r.status===200, r.status+' '+JSON.stringify(r.json).slice(0,200)) }
r = await call(cust.token,'POST',`/exchange-requests/${EX.id}/cancel`,{ reason:'x' }); console.log('   cancel after complete ->', r.status)
process.exit(summary()?1:0)
