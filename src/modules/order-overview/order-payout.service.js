import { query, getClient } from '../../config/database.js'
import { VendorSettlementsService } from '../vendor-settlements/vendor-settlements.service.js'

const err = (statusCode, message, code = 'PAYOUT_ERROR') => Object.assign(new Error(message), { statusCode, code })
const n = (x) => (x == null ? 0 : Number(x))
const WINDOW_DAYS = 7
const settlements = new VendorSettlementsService()

const LEDGER_LABEL = {
  GROSS_SALES: 'Sale value', SELLER_DISCOUNT: 'Discount given by the seller', PLATFORM_DISCOUNT: 'Discount paid by Dealker (added back)', COMMISSION: 'Dealker commission',
  LOGISTICS: 'Delivery cost', REFUND: 'Refund to the customer', PENALTY: 'Penalty', ADJUSTMENT: 'Adjustment', INCENTIVE: 'Incentive', PAYOUT: 'Paid out to the seller',
}

const STATE_TEXT = {
  WAITING_DELIVERY: ['Waiting for delivery', 'The seller is paid only after the customer has received the parcel.'],
  RETURN_WINDOW: ['Delivered — in the return window', 'Dealker keeps the money for {days} days in case the customer returns it.'],
  READY: ['Ready to be paid', 'The return window is over. You can pay the seller now.'],
  PROCESSING: ['Payout in progress', 'A payout has been created. Mark it as paid once the bank transfer is done.'],
  PAID: ['Paid', 'The seller has been paid for this parcel.'],
  ON_HOLD: ['On hold', 'Payment is paused. Release the hold when the issue is sorted out.'],
  REVERSED: ['Nothing to pay', 'This parcel was cancelled or returned, so the seller earns nothing from it.'],
}

/** Builds the payout block for every parcel of an order (called by the order overview). */
export async function payoutBlocks(sos) {
  if (!sos.length) return {}
  const ids = sos.map((s) => s.id)
  const vendorIds = [...new Set(sos.map((s) => s.vendor_id).filter(Boolean))]
  const ledger = (await query(`SELECT seller_order_id, entry_type, amount, reason, created_at FROM settlement_ledger WHERE seller_order_id = ANY($1) ORDER BY created_at, id`, [ids])).rows
  const holds = (await query(`SELECT seller_order_id, vendor_id, reason, created_at FROM settlement_holds WHERE is_active = true AND (seller_order_id = ANY($1) OR (seller_order_id IS NULL AND vendor_id = ANY($2)))`, [ids, vendorIds])).rows
  const links = (await query(
    `SELECT l.seller_order_id, l.amount, p.id AS payout_id, p.payout_number, p.status, p.utr_number, p.paid_at, p.created_at
       FROM seller_order_payouts l JOIN settlement_payouts p ON p.id = l.payout_id WHERE l.seller_order_id = ANY($1) ORDER BY p.created_at DESC`, [ids])).rows
  const bal = (await query(`SELECT vendor_id, COALESCE(SUM(amount),0) AS b FROM settlement_ledger WHERE vendor_id = ANY($1) GROUP BY vendor_id`, [vendorIds])).rows
  const out = {}
  for (const so of sos) {
    const link = links.find((l) => l.seller_order_id === so.id) || null
    const hold = holds.find((h) => h.seller_order_id === so.id) || holds.find((h) => !h.seller_order_id && h.vendor_id === so.vendor_id) || null
    const deliveredAt = so.delivered_at ? new Date(so.delivered_at) : null
    const eligibleOn = deliveredAt ? new Date(deliveredAt.getTime() + WINDOW_DAYS * 86400000) : null
    let state
    if (['CANCELLED', 'RETURNED'].includes(so.status) || so.payout_status === 'REVERSED') state = 'REVERSED'
    else if (link?.status === 'PAID') state = 'PAID'
    else if (link && ['PENDING', 'PROCESSING'].includes(link.status)) state = 'PROCESSING'
    else if (hold || so.payout_status === 'ON_HOLD') state = 'ON_HOLD'
    else if (so.status !== 'DELIVERED') state = 'WAITING_DELIVERY'
    else if (eligibleOn && eligibleOn > new Date()) state = 'RETURN_WINDOW'
    else state = 'READY'
    const [label, why] = STATE_TEXT[state]
    out[so.id] = {
      state, label, explanation: why.replace('{days}', String(WINDOW_DAYS)), eligible_on: eligibleOn, window_days: WINDOW_DAYS,
      earns: n(so.payable_to_seller),
      hold: hold ? { reason: hold.reason, since: hold.created_at, vendor_wide: !hold.seller_order_id } : null,
      payout: link ? { id: link.payout_id, number: link.payout_number, status: link.status, amount: n(link.amount), utr: link.utr_number, paid_at: link.paid_at, created_at: link.created_at } : null,
      vendor_balance: n(bal.find((b) => b.vendor_id === so.vendor_id)?.b),
      ledger: ledger.filter((l) => l.seller_order_id === so.id).map((l) => ({ type: l.entry_type, label: LEDGER_LABEL[l.entry_type] || l.entry_type, amount: n(l.amount), reason: l.reason, at: l.created_at })),
    }
  }
  return out
}

export const orderPayouts = {
  async hold(sellerOrderId, reason, actorId) {
    if (!String(reason || '').trim()) throw err(400, 'Please give a reason for holding the payment', 'VALIDATION_ERROR')
    const so = (await query(`SELECT id, vendor_id, order_id, status, payout_status FROM seller_orders WHERE id = $1`, [sellerOrderId])).rows[0]
    if (!so) throw err(404, 'Parcel not found', 'NOT_FOUND')
    if (['CANCELLED', 'RETURNED'].includes(so.status) || so.payout_status === 'REVERSED') throw err(409, 'There is nothing to pay on this parcel', 'INVALID_TRANSITION')
    if ((await query(`SELECT 1 FROM seller_order_payouts l JOIN settlement_payouts p ON p.id = l.payout_id WHERE l.seller_order_id = $1 AND p.status = 'PAID'`, [sellerOrderId])).rows[0]) throw err(409, 'This parcel has already been paid', 'INVALID_TRANSITION')
    const dupe = await query(`SELECT 1 FROM settlement_holds WHERE seller_order_id = $1 AND is_active = true`, [sellerOrderId])
    if (dupe.rows[0]) throw err(409, 'This parcel is already on hold', 'DUPLICATE')
    await query(`INSERT INTO settlement_holds (vendor_id, seller_order_id, reason, created_by) VALUES ($1,$2,$3,$4)`, [so.vendor_id, sellerOrderId, reason.trim(), actorId])
    await query(`UPDATE seller_orders SET payout_status = 'ON_HOLD', updated_at = NOW() WHERE id = $1`, [sellerOrderId])
    return so.order_id
  },

  async release(sellerOrderId, actorId) {
    const so = (await query(`SELECT order_id, status FROM seller_orders WHERE id = $1`, [sellerOrderId])).rows[0]
    if (!so) throw err(404, 'Parcel not found', 'NOT_FOUND')
    const r = await query(`UPDATE settlement_holds SET is_active = false, released_by = $2, released_at = NOW() WHERE seller_order_id = $1 AND is_active = true`, [sellerOrderId, actorId])
    if (!r.rowCount) throw err(409, 'There is no hold on this parcel to release (a vendor-wide hold is managed under Settlements)', 'INVALID_TRANSITION')
    await query(`UPDATE seller_orders SET payout_status = CASE WHEN status = 'DELIVERED' THEN 'ELIGIBLE' ELSE 'PENDING' END, updated_at = NOW() WHERE id = $1`, [sellerOrderId])
    return so.order_id
  },

  /** Pay the seller for this one parcel (its net amount), optionally before the return window ends. */
  async payNow(sellerOrderId, { early = false } = {}, actorId) {
    const [block] = [await (async () => { const so = (await query(`SELECT * FROM seller_orders WHERE id = $1`, [sellerOrderId])).rows[0]; if (!so) throw err(404, 'Parcel not found', 'NOT_FOUND'); return { so, b: (await payoutBlocks([so]))[so.id] } })()]
    const { so, b } = block
    if (b.state === 'ON_HOLD') throw err(409, 'Payment is on hold. Release the hold first.', 'ON_HOLD')
    if (b.state === 'PAID' || b.state === 'PROCESSING') throw err(409, 'A payout already exists for this parcel', 'DUPLICATE')
    if (b.state === 'REVERSED') throw err(409, 'There is nothing to pay on this parcel', 'INVALID_TRANSITION')
    if (b.state === 'WAITING_DELIVERY') throw err(409, 'The parcel has not been delivered yet', 'INVALID_TRANSITION')
    if (b.state === 'RETURN_WINDOW' && !early) throw err(409, `The return window ends on ${new Date(b.eligible_on).toLocaleDateString('en-IN')}. Confirm to pay early.`, 'RETURN_WINDOW')
    const net = Number(so.payable_to_seller)
    if (!(net > 0)) throw err(409, 'There is nothing to pay on this parcel', 'INVALID_TRANSITION')
    if (b.vendor_balance < net) throw err(409, `The seller’s balance (₹${b.vendor_balance}) is lower than this parcel’s payout (₹${net}).`, 'INSUFFICIENT_BALANCE')
    const payout = await settlements.createPayout(so.vendor_id, { amount: net, notes: `Payout for parcel ${so.seller_order_number}`, createdBy: actorId })
    await query(`INSERT INTO seller_order_payouts (payout_id, seller_order_id, amount) VALUES ($1,$2,$3)`, [payout.id, sellerOrderId, net])
    await query(`UPDATE seller_orders SET payout_status = 'PROCESSING', updated_at = NOW() WHERE id = $1`, [sellerOrderId])
    return so.order_id
  },

  async markPaid(payoutId, utr, actorId) {
    if (!String(utr || '').trim()) throw err(400, 'Enter the bank transfer reference (UTR)', 'VALIDATION_ERROR')
    const p = await settlements.markPayoutPaid(payoutId, { utrNumber: utr.trim(), actorId })
    if (!p) throw err(404, 'Payout not found', 'NOT_FOUND')
    const rows = (await query(`UPDATE seller_orders so SET payout_status = 'PAID', updated_at = NOW() FROM seller_order_payouts l WHERE l.payout_id = $1 AND l.seller_order_id = so.id RETURNING so.order_id`, [payoutId])).rows
    return rows[0]?.order_id
  },
}
void getClient
