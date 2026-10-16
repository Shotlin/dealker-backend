// Prep for hand-testing the customer app's auction flow on the live API.
// Creates ONE QA-prefixed B2C auction (TechNest) and funds the demo customer's wallet.
import { call, otpLogin, adminLogin, sleep, sampleImages, vendorIdOf, categoryId, PHONES } from './lib.mjs'
const A = await otpLogin(PHONES.vendorA), adm = await adminLogin(), c1 = await otpLogin(PHONES.customer)
const vA = vendorIdOf(A.token), images = await sampleImages(), cat = await categoryId()
let r = await call(adm.token, 'POST', `/wallet/admin/${c1.user.id}/credit`, { amount: 1500, description: 'QA customer-app auction test funding' })
console.log('credit', r.status, JSON.stringify(r.json).slice(0, 160))
const name = `QA-APP-AUCTION-${Date.now().toString(36)}`
const l = await call(adm.token, 'POST', '/admin/listings', { name, categoryId: cat, condition: 'NEW', stock: 1, price: 1000, mrp: 1500, images, ownerVendorId: vA, brand: 'QA' })
console.log('listing', l.status, l.data?.product_id)
r = await call(A.token, 'POST', '/manage/auctions', { audience: 'B2C', productId: l.data.product_id, title: name, startPrice: 1000, registrationFee: 50, durationHours: 3, reservePrice: 1000, bidIncrement: 50, buyNowPrice: 1300 })
console.log('auction', r.status, r.data?.id, r.json?.message)
await call(adm.token, 'POST', `/manage/auctions/${r.data.id}/approve`)
await sleep(1500)
console.log('AUCTION_ID', r.data.id, 'PRODUCT_ID', l.data.product_id, 'TITLE', name)
