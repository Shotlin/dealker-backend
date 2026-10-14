import { call, otpLogin, adminLogin, check, summary, PHONES, sleep, sampleImages, vendorIdOf, categoryId } from './lib.mjs'
const B = await otpLogin(PHONES.vendorB), adm = await adminLogin(), cust = await otpLogin(PHONES.customer)
const vB = vendorIdOf(B.token); const images = await sampleImages(); const cat = await categoryId()
console.log('--- KYC flow on a throwaway vendor')
const slug = 'qa-kyc-' + Date.now().toString(36)
let r = await call(adm.token,'POST','/vendors',{ name:`QA KYC ${slug}`, email:`${slug}@qa.dealker.test`, phone:'98'+String(Date.now()).slice(-8), status:'PENDING_ONBOARDING' }); check('admin creates vendor', r.status===201||r.status===200, JSON.stringify(r.json).slice(0,300)); const V = r.data
r = await call(adm.token,'POST','/vendors',{ name:'x', email:'bad', phone:'abc' }); check('bad vendor payload rejected', r.status===400)
r = await call(adm.token,'POST',`/vendor-kyc/${V.id}/kyc`,{ documents:[] }); check('empty documents rejected', r.status===400, r.status)
r = await call(adm.token,'POST',`/vendor-kyc/${V.id}/kyc`,{ documents:[{ document_type:'PAN_CARD', file_key:'qa/pan.jpg', document_number:'ABCDE1234F' },{ document_type:'GSTIN_CERTIFICATE', file_key:'qa/gst.jpg', document_number:'29ABCDE1234F1Z5' }], profile:{ legal_name:'QA KYC Pvt Ltd', pan_number:'ABCDE1234F', gstin:'29ABCDE1234F1Z5' } }); check('KYC submitted', r.status===200||r.status===201, JSON.stringify(r.json).slice(0,300))
r = await call(adm.token,'GET',`/vendors/${V.id}`); console.log('    status after submit', r.data?.status)
r = await call(adm.token,'POST',`/vendor-kyc/${V.id}/kyc/review`,{ action:'START_REVIEW' }); check('start review', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(adm.token,'POST',`/vendor-kyc/${V.id}/kyc/review`,{ action:'REQUEST_CORRECTION', comments:'QA fix PAN' }); check('request correction', r.status===200, JSON.stringify(r.json).slice(0,200)); 
r = await call(adm.token,'GET',`/vendors/${V.id}`); console.log('    status after correction', r.data?.status)
r = await call(adm.token,'POST',`/vendor-kyc/${V.id}/kyc`,{ documents:[{ document_type:'PAN_CARD', file_key:'qa/pan2.jpg' }] }); console.log('    resubmit ->', r.status)
r = await call(adm.token,'POST',`/vendor-kyc/${V.id}/kyc/review`,{ action:'START_REVIEW' }); console.log('    start review 2 ->', r.status, r.json?.message)
r = await call(B.token,'POST',`/vendor-kyc/${V.id}/kyc/review`,{ action:'APPROVE' }); check('vendor B cannot approve KYC', r.status===403, r.status)
r = await call(adm.token,'POST',`/vendor-kyc/${V.id}/kyc/review`,{ action:'APPROVE', comments:'QA ok' }); console.log('    approve ->', r.status, JSON.stringify(r.json).slice(0,200))
r = await call(adm.token,'GET',`/vendors/${V.id}`); console.log('    status after approve', r.data?.status); check('vendor becomes VERIFIED/ACTIVE after approval', ['VERIFIED','ACTIVE'].includes(r.data?.status), r.data?.status)
r = await call(adm.token,'GET',`/vendor-kyc/${V.id}/kyc/status`); console.log('    onboarding', JSON.stringify(r.json).slice(0,300))
r = await call(adm.token,'PATCH',`/vendors/${V.id}/status`,{ status:'DEACTIVATED', reason:'QA cleanup' }); console.log('    deactivate ->', r.status)
console.log('--- suspended vendor blocked from selling')
r = await call(adm.token,'PATCH',`/vendors/${vB}/status`,{ status:'SUSPENDED', reason:'QA suspend test' }); check('admin suspends QA vendor B', r.status===200, JSON.stringify(r.json).slice(0,200))
await sleep(500)
const B2 = await otpLogin(PHONES.vendorB).catch(e=>({ token:null, err:e.message })); console.log('    login after suspend ->', B2.token ? 'token issued' : B2.err?.slice(0,150))
const tk = B2.token || B.token
const attempts = {
  'create listing': ['POST','/vendor/listings',{ name:'QA suspended listing', categoryId:cat, condition:'NEW', stock:1, price:100, mrp:120, images }],
  'post demand': ['POST','/vendor/b2b/requirements',{ productName:'QA suspended demand', quantity:1, responseDeadline:new Date(Date.now()+864e5).toISOString() }],
  'transfer wallet': ['POST','/settlements/transfer-to-wallet',{ amount: 10 }],
  'ad wallet topup': ['POST','/manage/ads/wallet/topup',{ amount: 500 }],
  'create auction': ['POST','/manage/auctions',{ audience:'B2B', productId:'3f2a5b4c-0000-4000-8000-000000000000', startPrice:100, registrationFee:10, durationHours:1 }],
  'list seller orders': ['GET','/seller-orders'], 'list listings': ['GET','/vendor/listings'],
}
for (const [k,[m,p,b]] of Object.entries(attempts)) { const x = await call(tk,m,p,b); console.log(`    ${k} -> ${x.status} ${x.json?.code||''} ${(x.json?.message||'').slice(0,70)}`); check(`suspended vendor: ${k} not allowed to write`, m==='GET' || x.status>=400, x.status) }
r = await call(adm.token,'PATCH',`/vendors/${vB}/status`,{ status:'ACTIVE', reason:'QA restore' }); check('admin restores vendor B', r.status===200, JSON.stringify(r.json).slice(0,200))
r = await call(B.token,'GET','/vendor/listings'); check('vendor B works again', r.status===200, r.status)
process.exit(summary()?1:0)
