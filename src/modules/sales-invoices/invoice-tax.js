/**
 * GST maths for sales documents — pure, integer paise, no I/O.
 *
 * Intra-state supply  → CGST + SGST (half each).   Inter-state → IGST.
 * Tax is computed per line on the taxable value (after line discount) and rounded to the paisa; document
 * totals are the sums of the rounded lines, so a printed invoice always adds up exactly.
 *
 * What this module deliberately does NOT decide: which rate or HSN/SAC applies to a product, or whether
 * the margin scheme is available for second-hand goods. Callers pass the rate in; that policy belongs to
 * the tax-profile layer and must be reviewed by an accountant.
 */

/** GST state / UT codes (first two digits of a GSTIN). */
export const STATES = Object.freeze({
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
})

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '')
const BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [norm(name), code]))
// Common alternative spellings.
for (const [alias, code] of [['orissa', '21'], ['pondicherry', '34'], ['uttaranchal', '05'], ['nctofdelhi', '07'], ['newdelhi', '07'], ['jammuandkashmir', '01'],
  ['andamanandnicobar', '35'], ['dadraandnagarhaveli', '26'], ['damananddiu', '26'], ['dadranagarhavelidamandiu', '26']]) BY_NAME.set(alias, code)

/** State code from a state name, or null when it cannot be matched. */
export const stateCodeFromName = (name) => BY_NAME.get(norm(name)) ?? null
/** State code from a GSTIN, or null when the GSTIN is malformed or the code is unknown. */
export const stateCodeFromGstin = (gstin) => {
  const g = String(gstin || '').trim().toUpperCase()
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && STATES[g.slice(0, 2)] ? g.slice(0, 2) : null
}

const paise = (r) => Math.round(Number(r) * 100)
const rupees = (p) => p / 100

/**
 * @param {{description:string,hsnSac?:string,qty:number,unitPrice:number,discount?:number,taxRate:number,unit?:string}[]} lines
 *        `unitPrice` and `discount` are tax-exclusive unless `taxInclusive` is set.
 * @param {{supply:'INTRA'|'INTER', taxInclusive?:boolean}} opts
 */
export function computeDocument(lines, { supply, taxInclusive = false }) {
  const out = []
  const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 }
  const byRate = new Map()
  for (const l of lines) {
    const rate = Number(l.taxRate) || 0
    let disc = 0, taxable, tax
    if (l.taxablePaise != null) {
      // Pre-computed taxable value (credit notes carved out of an issued line): tax follows from the rate.
      taxable = l.taxablePaise
      tax = Math.round((taxable * rate) / 100)
    } else {
      const gross = Math.round(l.qty * paise(l.unitPrice))
      disc = paise(l.discount || 0)
      if (disc > gross) throw new RangeError(`Discount exceeds the value of "${l.description}"`)
      const net = gross - disc
      // Tax-inclusive: the entered value already contains tax, so back it out.
      taxable = taxInclusive ? Math.round((net * 100) / (100 + rate)) : net
      tax = taxInclusive ? net - taxable : Math.round((taxable * rate) / 100)
    }
    const half = Math.round(tax / 2)
    const cgst = supply === 'INTRA' ? half : 0
    const sgst = supply === 'INTRA' ? tax - half : 0
    const igst = supply === 'INTER' ? tax : 0
    out.push({
      description: l.description, hsnSac: l.hsnSac || '', unit: l.unit || 'NOS', qty: l.qty, unitPrice: l.taxablePaise != null || taxInclusive ? rupees(Math.round(taxable / l.qty)) : rupees(paise(l.unitPrice)),
      discount: rupees(disc), taxable: rupees(taxable), taxRate: rate, cgst: rupees(cgst), sgst: rupees(sgst), igst: rupees(igst), total: rupees(taxable + tax),
      ...(l.meta ? { meta: l.meta } : {}),
    })
    totals.taxable += taxable; totals.cgst += cgst; totals.sgst += sgst; totals.igst += igst; totals.total += taxable + tax
    const key = `${l.hsnSac || ''}|${rate}`
    const g = byRate.get(key) || { hsnSac: l.hsnSac || '', taxRate: rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    g.taxable += taxable; g.cgst += cgst; g.sgst += sgst; g.igst += igst
    byRate.set(key, g)
  }
  return {
    lines: out,
    taxSummary: [...byRate.values()].map((g) => ({ ...g, taxable: rupees(g.taxable), cgst: rupees(g.cgst), sgst: rupees(g.sgst), igst: rupees(g.igst) })),
    taxable: rupees(totals.taxable), cgst: rupees(totals.cgst), sgst: rupees(totals.sgst), igst: rupees(totals.igst), total: rupees(totals.total),
  }
}

/** Indian financial year of a date, as 'YY-YY' (April–March). */
export function financialYear(date) {
  const d = new Date(date)
  const y = d.getUTCFullYear()
  const start = d.getUTCMonth() >= 3 ? y : y - 1
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const below100 = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`)
const below1000 = (n) => (n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${below100(n % 100)}` : ''}` : below100(n))

/** "Rupees One Thousand Two Hundred and Fifty Paise Only" — Indian lakh/crore grouping. */
export function amountInWords(amount) {
  const p = Math.round(Number(amount) * 100)
  let r = Math.floor(p / 100)
  const ps = p % 100
  if (r === 0 && ps === 0) return 'Rupees Zero Only'
  const parts = []
  for (const [div, name] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
    const q = Math.floor(r / div)
    if (q) { parts.push(`${below1000(q)} ${name}`); r -= q * div }
  }
  if (r) parts.push(below1000(r))
  const rs = parts.join(' ')
  return `Rupees ${rs}${rs && ps ? ' and ' : ''}${ps ? `${below100(ps)} Paise` : ''} Only`.replace('Rupees  ', 'Rupees ')
}
