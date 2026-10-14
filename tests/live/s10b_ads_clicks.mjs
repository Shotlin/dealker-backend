import { call, otpLogin, adminLogin, check, summary, PHONES, sleep, sampleImages, vendorIdOf, categoryId } from './lib.mjs'
const B = await otpLogin(PHONES.vendorB), c1 = await otpLogin(PHONES.customer), c2 = await otpLogin(PHONES.customer2), adm = await adminLogin()
const images = await sampleImages(); const cat = await categoryId(); const kw = 'qaclick' + Date.now().toString(36)
const L = (await call(adm.token,'POST','/admin/listings',{ name:`QA-AD ${kw} thing`, categoryId:cat, condition:'NEW', stock:20, price:700, mrp:900, images, ownerVendorId:vendorIdOf(B.token), brand:'QA' })).data
const w = async () => Number((await call(B.token,'GET','/manage/ads/wallet')).data.balance)
await call(B.token,'POST','/manage/ads/wallet/topup',{ amount: 500 })
const C = (await call(B.token,'POST','/manage/ads',{ name:`QA Click ${kw}`, targeting:'MANUAL', defaultBid:5, dailyBudget:100, productIds:[L.product_id], keywords:[{ keyword:kw, matchType:'EXACT' }], submit:true })).data
await call(adm.token,'POST',`/manage/ads/${C.id}/approve`); await sleep(800)
const tok = async (t) => ((await call(t,'GET',`/discovery/search?q=${kw}&limit=5`)).json.data||[]).find(x=>x.is_sponsored)?.ad?.token
let t = await tok(B.token); let w0 = await w(); await call(B.token,'POST','/ads/click',{ token:t }); await sleep(400); let w1 = await w()
check('advertiser clicking own ad is NOT charged', Math.abs(w0-w1)<0.01, `${w0}→${w1}`)
t = await tok(c1.token); w0 = await w(); await call(c1.token,'POST','/ads/click',{ token:t }); await sleep(400); w1 = await w(); check('customer 1 click charged once', w0-w1>0, `${w0}→${w1}`)
await call(c1.token,'POST','/ads/click',{ token:t }); await sleep(300); check('same customer same token again: no charge', Math.abs((await w())-w1)<0.01)
t = await tok(c1.token); await call(c1.token,'POST','/ads/click',{ token:t }); await sleep(300); check('same customer fresh token within window: no second charge (dedupe)', Math.abs((await w())-w1)<0.01, `${w1}→${await w()}`)
t = await tok(c2.token); const w2 = await w(); await call(c2.token,'POST','/ads/click',{ token:t }); await sleep(400); check('different customer charged', w2-(await w())>0)
// budget exhaustion: daily 100, bid 5 + gst => ~17 clicks; hammer with distinct anonymous users is not possible; just check report consistency
const rep = await call(B.token,'GET',`/manage/ads/${C.id}/report`); console.log('   report', JSON.stringify(rep.data?.totals||rep.data).slice(0,250))
await call(B.token,'POST',`/manage/ads/${C.id}/end`)
const afterEnd = await call(B.token,'POST','/manage/ads/wallet/withdraw',{ amount: 100 }); console.log('   withdraw 100 ->', afterEnd.status, afterEnd.json?.message)
process.exit(summary()?1:0)
