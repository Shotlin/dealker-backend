import { call, otpLogin, adminLogin, check, summary, PHONES, vendorIdOf } from './lib.mjs'
const R = await otpLogin(PHONES.repair), adm = await adminLogin(), vR = vendorIdOf(R.token)
const sum = async () => (await call(R.token,'GET','/settlements/summary')).data
const stmt = async () => (await call(R.token,'GET','/settlements/statement?limit=1')).json
let s0 = await sum(); console.log('   summary', JSON.stringify(s0))
// bring the balance to a known 1000
const cur = s0.available; if (cur !== 1000) await call(adm.token,'POST',`/admin/settlements/vendors/${vR}/adjust`,{ amount: 1000-cur, reason:'QA race reset' })
s0 = await sum(); check('summary available equals true ledger balance', Math.abs(s0.available-1000)<0.01, JSON.stringify(s0))
const results = await Promise.all(Array.from({length:8}, (_,i)=>call(R.token,'POST','/settlements/transfer-to-wallet',{ amount: 400 })))
const ok = results.filter(r=>r.status===200).length, rej = results.filter(r=>r.status===402).length
console.log('   parallel transfers: ok', ok, 'insufficient', rej, 'other', results.filter(r=>![200,402].includes(r.status)).map(r=>r.status))
check('at most 2 of 8×₹400 succeed from ₹1000', ok===2, `ok=${ok}`)
const s1 = await sum(); check('balance = 200 and never negative', Math.abs(s1.available-200)<0.01, JSON.stringify(s1))
// parallel ad top-up vs transfer from same balance (200): min topup 500 so use transfer vs admin debit
const mix = await Promise.all([ call(R.token,'POST','/settlements/transfer-to-wallet',{ amount: 150 }), call(R.token,'POST','/settlements/transfer-to-wallet',{ amount: 150 }), call(R.token,'POST','/settlements/transfer-to-wallet',{ amount: 150 }) ])
check('only one 150 fits in 200', mix.filter(r=>r.status===200).length===1, mix.map(r=>r.status).join(','))
const s2 = await sum(); check('final 50', Math.abs(s2.available-50)<0.01, JSON.stringify(s2))
process.exit(summary()?1:0)
