// Deletes vendor A/B listings whose name contains "QA" / "script" created by tests
import { call, otpLogin, PHONES } from './lib.mjs'
for (const ph of [PHONES.vendorA, PHONES.vendorB]) {
  const v = await otpLogin(ph)
  for (let pass = 0; pass < 3; pass++) {
    const r = await call(v.token,'GET','/vendor/listings?limit=100')
    const rows = (r.json?.data||[]).filter(x => /^(QA-|Q[A-Z][0-9A-Z]{6,} )|<script>/i.test(x.name||''))
    if (!rows.length) break
    for (const x of rows) { const d = await call(v.token,'DELETE',`/vendor/listings/${x.id}`); console.log(ph, x.name, d.status) }
  }
}
