/**
 * A4 GST document renderer (tax invoice, bill of supply, credit note, debit note).
 * Renders only from the stored snapshot, so a re-render is always identical to what was issued.
 * No IRN or QR code is drawn: e-invoicing is not integrated and nothing official is fabricated.
 */
import PDFDocument from 'pdfkit'
import { STORE_INFO } from '../../config/storeInfo.js'
import { STATES, amountInWords } from './invoice-tax.js'

const FONT = 'body'
const BOLD = 'Helvetica-Bold'
const M = 36, W = 523
const TITLES = { TAX_INVOICE: 'TAX INVOICE', BILL_OF_SUPPLY: 'BILL OF SUPPLY', CREDIT_NOTE: 'CREDIT NOTE', DEBIT_NOTE: 'DEBIT NOTE' }
const money = (n) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dmy = (d) => { const x = new Date(d); return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}` }

const COLS = [
  ['#', 20, 'left'], ['Description', 142, 'left'], ['HSN/SAC', 44, 'left'], ['Qty', 28, 'right'], ['Rate', 52, 'right'], ['Disc.', 40, 'right'],
  ['Taxable', 56, 'right'], ['GST%', 28, 'right'], ['GST', 50, 'right'], ['Amount', 63, 'right'],
]

function party(doc, x, y, w, title, p) {
  doc.font(BOLD).fontSize(7.5).fillColor('#6b7280').text(title.toUpperCase(), x, y, { width: w })
  doc.font(BOLD).fontSize(9.5).fillColor('#111827').text(p.businessName || p.legalName || p.name || '—', x, doc.y + 2, { width: w })
  doc.font(FONT).fontSize(8).fillColor('#374151')
  if (p.businessName && p.name) doc.text(`Attn: ${p.name}`, { width: w })
  if (p.address) doc.text(p.address, { width: w })
  if (p.state) doc.text(`State: ${p.state}${p.stateCode ? ` (${p.stateCode})` : ''}`, { width: w })
  if (p.gstin) doc.text(`GSTIN: ${p.gstin}`, { width: w })
  else if (p.gstin === null) doc.text('GSTIN: Unregistered', { width: w })
  if (p.pan) doc.text(`PAN: ${p.pan}`, { width: w })
  if (p.phone) doc.text(`Phone: ${p.phone}`, { width: w })
  if (p.email) doc.text(p.email, { width: w })
}

/** @param {object} d  a sales_documents row (snake_case columns as stored) */
export function renderDocumentPdf(d, { original } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, info: { Title: `${TITLES[d.doc_type]} ${d.doc_number}`, Producer: 'Dealker' } })
    const chunks = []
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject)
    doc.registerFont(FONT, STORE_INFO.currencyFontPath)

    const seller = d.seller, buyer = d.buyer
    const intra = d.supply_type === 'INTRA'
    const isNote = d.doc_type === 'CREDIT_NOTE' || d.doc_type === 'DEBIT_NOTE'

    // header
    doc.font(BOLD).fontSize(18).fillColor('#111827').text(TITLES[d.doc_type], M, M, { width: W / 2 })
    doc.font(FONT).fontSize(8).fillColor('#6b7280').text(d.doc_type === 'TAX_INVOICE' ? 'Original for recipient' : d.doc_type === 'BILL_OF_SUPPLY' ? 'Issued by a supplier not registered for GST, or for exempt supplies' : '', M, doc.y, { width: W / 2 })
    const top = M
    doc.font(BOLD).fontSize(9).fillColor('#111827')
    const meta = [
      [`${isNote ? 'Note' : 'Invoice'} No.`, d.doc_number], [`${isNote ? 'Note' : 'Invoice'} Date`, dmy(d.issue_date)],
      ...(original ? [['Against invoice', `${original.doc_number} (${dmy(original.issue_date)})`]] : []),
      ...(d.order_ref ? [['Order / Ref', d.order_ref]] : []), ...(d.po_reference ? [['PO No.', d.po_reference]] : []),
      ['Place of supply', `${STATES[d.place_of_supply] || ''} (${d.place_of_supply})${d.pos_assumed ? ' *' : ''}`],
      ...(d.due_date && !isNote ? [['Due date', dmy(d.due_date)]] : []),
    ]
    let my = top
    for (const [k, v] of meta) {
      doc.font(FONT).fontSize(8).fillColor('#6b7280').text(k, M + W / 2, my, { width: 90 })
      doc.font(BOLD).fontSize(8.5).fillColor('#111827').text(String(v), M + W / 2 + 92, my, { width: W / 2 - 92, align: 'left' })
      my += 13
    }
    let y = Math.max(doc.y, my) + 10
    doc.moveTo(M, y).lineTo(M + W, y).strokeColor('#d1d5db').stroke()
    y += 8

    // parties
    party(doc, M, y, W / 2 - 10, isNote ? 'Issued by' : 'Sold by', seller)
    const sy = doc.y
    party(doc, M + W / 2 + 10, y, W / 2 - 10, isNote ? 'Issued to' : 'Billed to', buyer)
    y = Math.max(sy, doc.y) + 6
    if (buyer.shipTo && buyer.shipTo !== buyer.address) {
      doc.font(BOLD).fontSize(7.5).fillColor('#6b7280').text('SHIP TO', M + W / 2 + 10, y, { width: W / 2 - 10 })
      doc.font(FONT).fontSize(8).fillColor('#374151').text(buyer.shipTo, { width: W / 2 - 10 })
      y = doc.y + 4
    }
    y += 6

    // lines table
    const header = (yy) => {
      doc.rect(M, yy, W, 18).fill('#f3f4f6')
      let x = M
      doc.font(BOLD).fontSize(7.5).fillColor('#374151')
      for (const [t, w, a] of COLS) { doc.text(t, x + 2, yy + 5, { width: w - 4, align: a }); x += w }
      return yy + 20
    }
    y = header(y)
    d.lines.forEach((l, i) => {
      const gst = Number(l.cgst) + Number(l.sgst) + Number(l.igst)
      const cells = [String(i + 1), l.description, l.hsnSac || '—', String(l.qty), money(l.unitPrice), Number(l.discount) ? money(l.discount) : '—', money(l.taxable), `${l.taxRate}`, money(gst), money(l.total)]
      doc.font(FONT).fontSize(8)
      const h = Math.max(16, doc.heightOfString(l.description, { width: COLS[1][1] - 4 }) + 8)
      if (y + h > 760) { doc.addPage(); y = header(M) }
      let x = M
      doc.fillColor('#111827')
      cells.forEach((c, n) => { doc.text(c, x + 2, y + 4, { width: COLS[n][1] - 4, align: COLS[n][2] }); x += COLS[n][1] })
      y += h
      doc.moveTo(M, y).lineTo(M + W, y).strokeColor('#e5e7eb').stroke()
    })
    y += 8

    // tax summary + totals
    if (y > 640) { doc.addPage(); y = M }
    const sumX = M, sumW = 300
    doc.font(BOLD).fontSize(7.5).fillColor('#6b7280').text('TAX SUMMARY', sumX, y)
    let ty = y + 12
    const sc = intra ? [['HSN/SAC', 56], ['Taxable', 66], ['Rate', 30], ['CGST', 56], ['SGST', 56]] : [['HSN/SAC', 70], ['Taxable', 80], ['Rate', 40], ['IGST', 80]]
    let x = sumX
    doc.font(BOLD).fontSize(7.5).fillColor('#374151')
    for (const [t, w] of sc) { doc.text(t, x, ty, { width: w - 4, align: t === 'HSN/SAC' ? 'left' : 'right' }); x += w }
    ty += 11
    doc.font(FONT).fontSize(8).fillColor('#111827')
    for (const g of d.tax_summary) {
      x = sumX
      const vals = intra ? [g.hsnSac || '—', money(g.taxable), `${g.taxRate}%`, money(g.cgst), money(g.sgst)] : [g.hsnSac || '—', money(g.taxable), `${g.taxRate}%`, money(g.igst)]
      vals.forEach((v, n) => { doc.text(v, x, ty, { width: sc[n][1] - 4, align: n === 0 ? 'left' : 'right' }); x += sc[n][1] })
      ty += 12
    }

    const tx = M + 330, tw = W - 330
    let ry = y
    const row = (label, value, strong) => {
      doc.fontSize(strong ? 10 : 8.5).fillColor('#111827')
      // Amounts always use the embedded font: the built-in bold has no ₹ glyph.
      doc.font(strong ? BOLD : FONT).text(label, tx, ry, { width: tw - 90 })
      doc.font(FONT).text(value, tx + tw - 90, ry, { width: 90, align: 'right' }); ry += strong ? 16 : 13
    }
    row('Taxable value', money(d.taxable_total))
    if (intra) { row('CGST', money(d.cgst_total)); row('SGST', money(d.sgst_total)) } else row('IGST', money(d.igst_total))
    if (Number(d.round_off)) row('Round off', money(d.round_off))
    doc.moveTo(tx, ry).lineTo(tx + tw, ry).strokeColor('#9ca3af').stroke(); ry += 4
    row(isNote ? 'Note total' : 'Total', money(d.grand_total), true)
    const paid = (d.payments || []).reduce((n, p) => n + Number(p.amount) * (p.kind === 'REFUND' ? -1 : 1), 0)
    if (!isNote && d.payments?.length) {
      row('Paid at issue', money(paid))
      row('Balance due', money(Math.max(0, Number(d.grand_total) - paid)))
    }
    y = Math.max(ty, ry) + 10
    doc.font(FONT).fontSize(8).fillColor('#374151').text(`Amount in words: ${amountInWords(d.grand_total)}`, M, y, { width: W })
    y = doc.y + 8

    if (d.reason) { doc.font(BOLD).fontSize(8).text('Reason: ', M, y, { continued: true }).font(FONT).text(d.reason, { width: W }); y = doc.y + 6 }
    if (d.notes) { doc.font(FONT).fontSize(8).fillColor('#374151').text(d.notes, M, y, { width: W }); y = doc.y + 6 }
    if (d.pos_assumed) { doc.font(FONT).fontSize(7.5).fillColor('#6b7280').text('* Recipient state not available — place of supply taken as the supplier’s state.', M, y, { width: W }); y = doc.y + 6 }
    if (d.terms) { doc.font(BOLD).fontSize(7.5).fillColor('#6b7280').text('TERMS', M, y); doc.font(FONT).fontSize(7.5).fillColor('#6b7280').text(d.terms, { width: W - 150 }); y = doc.y }

    const fy = Math.max(y + 16, 770)
    if (fy > 800) { doc.addPage() }
    const by = Math.min(Math.max(y + 16, 740), 790)
    doc.font(FONT).fontSize(7.5).fillColor('#9ca3af').text(settingsFooter(d), M, by, { width: W - 160 })
    doc.font(FONT).fontSize(8).fillColor('#374151').text(`For ${seller.legalName || seller.name}`, M + W - 150, by - 22, { width: 150, align: 'right' })
    doc.text('Authorised signatory', M + W - 150, by, { width: 150, align: 'right' })
    doc.end()
  })
}

const settingsFooter = (d) => d.seller?.footer || 'This is a computer-generated document.'
