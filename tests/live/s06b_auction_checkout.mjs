import { call, otpLogin, adminLogin, check, summary, PHONES, sleep, ensureAddress } from './lib.mjs'
const AU = process.argv[2]; if (!AU) { console.log('usage: s06b <auctionId>'); process.exit(2) }
const A = await otpLogin(PHONES.vendorA), B = await otpLogin(PHONES.vendorB), R = await otpLogin(PHONES.repair), adm = await adminLogin()
const wallet = async (t) => Number((await call(t,'GET','/wallet')).data?.balance)
const addr = await ensureAddress(R.token)
let r = await call(B.token,'POST',`/auctions/${AU}/checkout`,{ addressId: (await ensureAddress(B.token)).id, paymentMethod:'WALLET' }); check('non-winner cannot checkout', r.status>=400, r.status+' '+r.json?.code)
r = await call(R.token,'POST',`/auctions/${AU}/checkout`,{ addressId:'3f2a5b4c-0000-4000-8000-000000000000', paymentMethod:'WALLET' }); check('foreign/unknown address rejected', r.status>=400, r.status+' '+r.json?.code)
const w0 = await wallet(R.token), sellerBefore = (await call(A.token,'GET','/settlements/summary')).data
r = await call(R.token,'POST',`/auctions/${AU}/checkout`,{ addressId:addr.id, paymentMethod:'WALLET' }); check('winner pays by wallet', r.status===200, JSON.stringify(r.json).slice(0,400)); console.log('   ', JSON.stringify(r.data)?.slice(0,300))
const w1 = await wallet(R.token); check('wallet debited amount_due 1300', Math.abs((w0-w1)-1300)<0.01, w0-w1)
r = await call(R.token,'POST',`/auctions/${AU}/checkout`,{ addressId:addr.id, paymentMethod:'WALLET' }); check('second checkout rejected', r.status>=400, r.status+' '+r.json?.code); check('no double debit', Math.abs(await wallet(R.token)-w1)<0.01)
r = await call(adm.token,'GET',`/manage/auctions/${AU}`); console.log('   auction status', r.data?.status)
const so = await call(A.token,'GET',`/seller-orders?search=${encodeURIComponent('')}&limit=3`); console.log('   A newest seller order', JSON.stringify(so.json?.data?.[0])?.slice(0,300))
r = await call(A.token,'GET','/manage/auctions/orders'); console.log('   A auction orders', JSON.stringify(r.json?.data?.[0])?.slice(0,400))
process.exit(summary()?1:0)
