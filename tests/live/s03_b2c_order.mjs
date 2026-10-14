import { call, otpLogin, adminLogin, check, summary, PHONES, QA, sleep, sampleImages, vendorIdOf, categoryId, ensureAddress } from './lib.mjs'
const A = await otpLogin(PHONES.vendorA), B = await otpLogin(PHONES.vendorB), adm = await adminLogin(), cust = await otpLogin(PHONES.customer2)
const tag = QA('ord'); const images = await sampleImages(); const cat = await categoryId()
let r = await call(adm.token,'POST','/admin/listings',{ name:`${tag} Order Phone`, categoryId:cat, condition:'NEW', stock:5, price:1000, mrp:1200, images, ownerVendorId:vendorIdOf(A.token), brand:'QA' })
check('admin creates approved listing for vendor A', r.status===201, JSON.stringify(r.json).slice(0,300)); const L = r.data
const addr = await ensureAddress(cust.token); check('address', !!addr?.id)
await call(cust.token,'DELETE','/cart')
r = await call(cust.token,'POST','/cart/items',{ shopProductId:L.id, quantity:99 }); check('qty > stock rejected', r.status===400, r.status)
r = await call(cust.token,'POST','/cart/items',{ shopProductId:L.id, quantity:-1 }); check('negative qty rejected', r.status===400, r.status)
r = await call(cust.token,'POST','/cart/items',{ shopProductId:L.id, quantity:2 }); check('add 2 to cart', r.status===200, JSON.stringify(r.json).slice(0,300))
r = await call(cust.token,'GET','/cart'); check('cart subtotal 2000', Number(r.data?.subtotal)===2000, JSON.stringify(r.data).slice(0,300)); console.log('   priceMode', r.data?.priceMode)
r = await call(cust.token,'POST','/orders',{ addressId:addr.id, paymentMethod:'COD', priceMode:'wholesale' }); console.log('   wholesale attempt ->', r.status, r.json?.message)
if (r.status===201) { check('customer must NOT order at wholesale priceMode', false, 'total '+JSON.stringify(r.data).slice(0,200)); }
else { check('customer wholesale priceMode did not create order', true) }
r = await call(cust.token,'POST','/orders',{ addressId:addr.id, paymentMethod:'COD' }); check('place COD order', r.status===201, JSON.stringify(r.json).slice(0,500))
const O = r.data?.order || r.data; const oid = O?.id; if (!oid) { console.log(JSON.stringify(r.json).slice(0,600)); summary(); process.exit(1) } console.log('   order', oid, O?.orderNumber||O?.order_number, 'total', O?.totalAmount??O?.total_amount??O?.total_payable)
await sleep(800)
r = await call(A.token,'GET',`/seller-orders?orderId=${oid}`); const so = (r.json?.data||[])[0]; check('vendor A sees its seller order', !!so && so.status==='ORDER_PLACED', JSON.stringify(r.json).slice(0,300))
console.log('   seller order', so?.id, so?.status, 'subtotal', so?.item_subtotal, 'commission', so?.commission_amount, 'payable', so?.payable_to_seller)
check('commission math payable = subtotal - commission', Math.abs(Number(so?.item_subtotal)-Number(so?.commission_amount)-Number(so?.payable_to_seller))<0.05)
r = await call(B.token,'GET',`/seller-orders?orderId=${oid}`); check('vendor B does NOT see it', (r.json?.data||[]).length===0)
r = await call(B.token,'GET',`/seller-orders/${so?.id}`); check('vendor B cannot read by id', r.status===404, r.status)
r = await call(B.token,'POST',`/seller-orders/${so?.id}/status`,{status:'CONFIRMED'}); check('vendor B cannot change', r.status===404, r.status)
r = await call(cust.token,'POST',`/seller-orders/${so?.id}/status`,{status:'CONFIRMED'}); check('customer cannot change', r.status===403, r.status)
r = await call(A.token,'GET',`/vendor/listings/${L.id}`); check('stock decremented 5→3', Number(r.data?.stock_quantity)===3, 'stock='+r.data?.stock_quantity)
r = await call(A.token,'POST',`/seller-orders/${so.id}/status`,{status:'DELIVERED'}); check('vendor cannot set DELIVERED', [403,409].includes(r.status), r.status)
r = await call(adm.token,'POST',`/seller-orders/${so.id}/status`,{status:'DELIVERED'}); check('admin cannot bypass shipment tracking', r.status===409, r.status)
r = await call(A.token,'POST',`/seller-orders/${so.id}/status`,{status:'BOGUS'}); check('bogus status rejected', r.status===400, r.status)
for (const s of ['CONFIRMED','PACKED','READY_TO_SHIP']) { r = await call(A.token,'POST',`/seller-orders/${so.id}/status`,{status:s}); check('vendor → '+s, r.status===200 && r.data?.status===s, JSON.stringify(r.json).slice(0,200)) }
// shipment via admin order-overview
const bal0 = (await call(A.token,'GET','/settlements/summary')).data
r = await call(adm.token,'POST',`/admin/order-overview/seller-orders/${so.id}/shipment`,{ provider:'SELF', courierName:'QA Courier', awb:'QA123' }); check('admin creates manual shipment', r.status===200, JSON.stringify(r.json).slice(0,300))
const ov = await call(adm.token,'GET',`/admin/order-overview/${oid}`); const sh = ov.data?.sellers?.[0]?.shipment || ov.data?.sellers?.[0]?.shipments?.[0]; console.log('   shipment', JSON.stringify(sh)?.slice(0,200))
const shid = sh?.id
for (const s of ['PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED']) { r = await call(adm.token,'POST',`/admin/order-overview/shipments/${shid}/event`,{status:s}); check('shipment → '+s, r.status===200, JSON.stringify(r.json).slice(0,200)); await sleep(300) }
r = await call(adm.token,'POST',`/admin/order-overview/shipments/${shid}/event`,{status:'IN_TRANSIT'}); check('event after DELIVERED rejected', r.status===409, r.status)
await sleep(1500)
r = await call(cust.token,'GET',`/orders/${oid}`); check('customer order status DELIVERED', /DELIVERED/.test(r.data?.status||''), r.data?.status)
r = await call(A.token,'GET',`/seller-orders/${so.id}`); check('seller order DELIVERED', r.data?.status==='DELIVERED', r.data?.status)
const bal1 = (await call(A.token,'GET','/settlements/summary')).data
console.log('   settlement before', JSON.stringify(bal0), 'after', JSON.stringify(bal1))
check('settlement increased by payable', Math.abs((bal1.available-bal0.available)-Number(so.payable_to_seller))<0.05 || bal1.nextPayout-bal0.nextPayout>0, `Δavail=${bal1.available-bal0.available} Δnext=${bal1.nextPayout-bal0.nextPayout}`)
const st = await call(A.token,'GET','/settlements/statement?limit=8'); console.log('   statement', st.status, JSON.stringify(st.json).slice(0,600))
console.log('\nIDS', JSON.stringify({tag, listing:L.id, product:L.product_id, order:oid, seller:so?.id, shipment:shid}))
process.exit(summary()?1:0)
