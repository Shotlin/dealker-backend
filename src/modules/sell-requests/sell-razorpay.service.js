/**
 * Razorpay for the sell-your-phone journey.
 *
 *  - Buyer funding: the buyer (vendor) pays the accepted amount through Razorpay Checkout (UPI / card / netbanking).
 *    A verified payment moves the request to HELD with no finance step. The client callback (`verifyFunding`) and the
 *    webhook (`completeFundingByOrder`) both end in the same idempotent `completeFunding`.
 *  - Buyer refunds (inspection failed, price dropped, sale cancelled) are returned to the original payment automatically.
 *  - Seller payouts: when RAZORPAYX_ACCOUNT_NUMBER is set, UPI / bank payouts go out through RazorpayX; webhooks
 *    (`payout.*`) or `syncPayout` finish them. Without it the payout waits in the finance queue exactly as before.
 *
 * Anything that cannot be done automatically is left PROCESSING in `sell_payments`, i.e. visible to finance.
 *
 * @module modules/sell-requests/sell-razorpay.service
 */
import crypto from 'node:crypto'
import { query } from '../../config/database.js'
import { env } from '../../config/env.js'
import { logger } from '../../config/logger.js'
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret } from '../../config/razorpay.js'
import { decryptSecret } from '../../utils/encryption.js'
import { SellError, addEvent, tx } from './sell-requests.service.js'
import { notifySellEvent } from './sell-requests.notify.js'

const SYSTEM = { kind: 'ADMIN', scopeKind: 'SELL', userId: null }
const money = (n) => Math.round(Number(n) * 100) / 100
const paise = (n) => Math.round(money(n) * 100)
const text = (v, max) => String(v ?? '').trim().slice(0, max)

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''), 'utf8'), y = Buffer.from(String(b ?? ''), 'utf8')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export const onlinePaymentsReady = () => Boolean(razorpay && getRazorpayKeyId() && getRazorpayKeySecret())
export const payoutsReady = () => Boolean(onlinePaymentsReady() && env.RAZORPAYX_ACCOUNT_NUMBER)

// ── Buyer funding ───────────────────────────────────────────────────────

/** Start (or resume) the Razorpay Checkout for the accepted amount. Returns what the app needs to open Checkout. */
export async function createFundingOrder(actor, id) {
  if (!onlinePaymentsReady()) throw new SellError('PAYMENTS_UNAVAILABLE', 'Online payments are not available right now', 503)
  const { rows } = await query('SELECT * FROM sell_requests WHERE id = $1 AND kind = $2', [id, 'SELL'])
  const r = rows[0]
  if (!r || (actor.kind === 'VENDOR' && r.assigned_vendor_id !== actor.vendorId)) throw new SellError('NOT_FOUND', 'Sell request not found', 404)
  if (!r.assigned_vendor_id || !r.accepted_offer_id) throw new SellError('INVALID_STATE', 'No offer has been accepted yet', 409)
  if (['CANCELLED', 'REJECTED', 'COMPLETED'].includes(r.status)) throw new SellError('INVALID_STATE', 'This request is closed', 409)
  if (!['PENDING', 'SUBMITTED'].includes(r.vendor_payment_status)) throw new SellError('INVALID_STATE', 'Payment for this request is already settled', 409)
  const amount = money(r.final_price)

  const { rows: open } = await query(
    `SELECT * FROM sell_razorpay_orders WHERE request_id = $1 AND status = 'CREATED' AND amount = $2 ORDER BY created_at DESC LIMIT 1`, [id, amount])
  let order = open[0]
  if (!order) {
    let rzp
    try {
      rzp = await razorpay.orders.create({
        amount: paise(amount), currency: 'INR', receipt: `sell-${r.code}`.slice(0, 40),
        notes: { kind: 'SELL_FUNDING', sell_request_id: id, vendor_id: r.assigned_vendor_id, code: r.code },
      })
    } catch (err) {
      logger.error({ err: err?.error || err?.message, requestId: id }, 'sell funding: Razorpay order creation failed')
      throw new SellError('PAYMENTS_UNAVAILABLE', 'Could not start the payment. Please try again.', 502)
    }
    const ins = await query(
      `INSERT INTO sell_razorpay_orders (request_id, vendor_id, razorpay_order_id, amount) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, r.assigned_vendor_id, rzp.id, amount])
    order = ins.rows[0]
  }
  return {
    keyId: getRazorpayKeyId(), orderId: order.razorpay_order_id, amount: paise(amount), amountRupees: amount, currency: 'INR',
    name: 'Dealker', description: `Phone purchase ${r.code}`, requestCode: r.code,
  }
}

/** The app's Checkout success callback. Checks Razorpay's signature, then the payment itself, then funds the sale. */
export async function verifyFunding(actor, id, input = {}) {
  const orderId = text(input.razorpayOrderId, 64), paymentId = text(input.razorpayPaymentId, 64), signature = text(input.razorpaySignature, 128)
  if (!orderId || !paymentId || !signature) throw new SellError('VALIDATION', 'Payment details are incomplete', 422)
  const { rows } = await query('SELECT o.*, r.assigned_vendor_id FROM sell_razorpay_orders o JOIN sell_requests r ON r.id = o.request_id WHERE o.razorpay_order_id = $1 AND o.request_id = $2', [orderId, id])
  const o = rows[0]
  if (!o || (actor.kind === 'VENDOR' && o.assigned_vendor_id !== actor.vendorId)) throw new SellError('NOT_FOUND', 'Payment not found', 404)
  const expected = crypto.createHmac('sha256', getRazorpayKeySecret()).update(`${orderId}|${paymentId}`).digest('hex')
  if (!safeEqual(expected, signature)) {
    logger.warn({ orderId, requestId: id }, 'sell funding: signature mismatch')
    throw new SellError('PAYMENT_VERIFICATION_FAILED', 'We could not verify this payment. If money was deducted it will be refunded automatically.', 400)
  }
  await completeFunding(orderId, paymentId, { source: 'APP_VERIFY' })
  return statusFor(id)
}

/** Webhook entry: `payment.captured` / `order.paid` for an order we created. Returns false when the order is not ours. */
export async function completeFundingByOrder(rzpOrderId, rzpPaymentId) {
  const { rows } = await query('SELECT 1 FROM sell_razorpay_orders WHERE razorpay_order_id = $1', [rzpOrderId])
  if (!rows[0]) return false
  await completeFunding(rzpOrderId, rzpPaymentId, { source: 'WEBHOOK' })
  return true
}

export async function failFundingByOrder(rzpOrderId, why) {
  await query(`UPDATE sell_razorpay_orders SET status = 'FAILED', note = $2, updated_at = NOW() WHERE razorpay_order_id = $1 AND status = 'CREATED'`, [rzpOrderId, text(why, 300)])
}

/** Confirm the payment with Razorpay itself (never trust the client), capturing it if the account does not auto-capture. */
async function confirmedPayment(paymentId, orderId, amount) {
  let p = await razorpay.payments.fetch(paymentId)
  if (p.order_id !== orderId) throw new SellError('PAYMENT_VERIFICATION_FAILED', 'This payment belongs to a different order', 400)
  if (Number(p.amount) !== paise(amount)) throw new SellError('AMOUNT_MISMATCH', 'The paid amount does not match', 400)
  if (p.status === 'authorized') p = await razorpay.payments.capture(paymentId, paise(amount), 'INR')
  if (p.status !== 'captured') throw new SellError('PAYMENT_NOT_COMPLETE', `The payment is ${p.status}`, 409)
  return p
}

/** The one idempotent place a verified Razorpay payment turns into held funds. */
export async function completeFunding(rzpOrderId, rzpPaymentId, { source = 'APP_VERIFY' } = {}) {
  const { rows: pre } = await query('SELECT * FROM sell_razorpay_orders WHERE razorpay_order_id = $1', [rzpOrderId])
  if (!pre[0]) throw new SellError('NOT_FOUND', 'Payment not found', 404)
  if (pre[0].status === 'PAID') return { skipped: true }
  const payment = await confirmedPayment(rzpPaymentId, rzpOrderId, pre[0].amount)

  let outcome = 'FUNDED', requestId = pre[0].request_id
  await tx(async (client) => {
    const { rows: [o] } = await client.query('SELECT * FROM sell_razorpay_orders WHERE razorpay_order_id = $1 FOR UPDATE', [rzpOrderId])
    if (o.status === 'PAID') { outcome = 'SKIPPED'; return }
    const { rows: [r] } = await client.query('SELECT * FROM sell_requests WHERE id = $1 FOR UPDATE', [o.request_id])
    const payable = r && r.assigned_vendor_id === o.vendor_id && ['PENDING', 'SUBMITTED'].includes(r.vendor_payment_status)
      && !['CANCELLED', 'REJECTED', 'COMPLETED'].includes(r.status) && money(r.final_price) === money(o.amount)
    await client.query(`UPDATE sell_razorpay_orders SET status = 'PAID', razorpay_payment_id = $2, updated_at = NOW() WHERE id = $1`, [o.id, rzpPaymentId])
    const method = ['upi', 'card', 'netbanking'].includes(payment.method) ? (payment.method === 'upi' ? 'UPI' : payment.method === 'card' ? 'CARD' : 'BANK') : 'RAZORPAY'
    if (!payable) {
      // Money arrived for a sale that can no longer use it (cancelled, already paid, price changed): hand it straight back.
      outcome = 'REFUND'
      await client.query(
        `INSERT INTO sell_payments (request_id, kind, method, amount, status, reference, provider_ref, note, idempotency_key, actor_role)
         VALUES ($1,'VENDOR_FUNDING',$2,$3,'CONFIRMED',$4,$4,'Not applied — refunded',$5,'SYSTEM') ON CONFLICT (request_id, idempotency_key) DO NOTHING`,
        [o.request_id, method, o.amount, rzpPaymentId, `rzp-${rzpPaymentId}`])
      await client.query(
        `INSERT INTO sell_payments (request_id, kind, method, amount, status, note, provider_ref, idempotency_key, actor_role)
         VALUES ($1,'VENDOR_REFUND','RAZORPAY',$2,'PROCESSING','Payment could not be applied to this sale',$3,$4,'SYSTEM') ON CONFLICT (request_id, idempotency_key) DO NOTHING`,
        [o.request_id, o.amount, rzpPaymentId, `refund-unapplied-${rzpPaymentId}`])
      await addEvent(client, o.request_id, 'VENDOR_PAYMENT_UNAPPLIED', 'A payment could not be applied and is being returned', null, { paymentId: rzpPaymentId })
      return
    }
    // A manual UTR the buyer typed earlier is superseded by the verified payment.
    await client.query(`UPDATE sell_payments SET status = 'FAILED', note = 'Superseded by an online payment', updated_at = NOW() WHERE request_id = $1 AND kind = 'VENDOR_FUNDING' AND status = 'SUBMITTED'`, [o.request_id])
    await client.query(
      `INSERT INTO sell_payments (request_id, kind, method, amount, status, reference, provider_ref, idempotency_key, actor_role)
       VALUES ($1,'VENDOR_FUNDING',$2,$3,'CONFIRMED',$4,$4,$5,'VENDOR') ON CONFLICT (request_id, idempotency_key) DO NOTHING`,
      [o.request_id, method, o.amount, rzpPaymentId, `rzp-${rzpPaymentId}`])
    await client.query(`UPDATE sell_requests SET vendor_payment_status = 'HELD', vendor_held_amount = $2, updated_at = NOW() WHERE id = $1`, [o.request_id, o.amount])
    await addEvent(client, o.request_id, 'VENDOR_FUNDED', 'Buyer payment received and held', null, { amount: money(o.amount), paymentId: rzpPaymentId, source })
  })
  if (outcome === 'FUNDED') {
    notifySellEvent('VENDOR_FUNDED', requestId)
    const { autoBookPickup } = await import('./sell-pickup-booking.service.js')
    await autoBookPickup(requestId).catch((err) => logger.error({ err: err.message, requestId }, 'auto pickup failed'))
  }
  if (outcome === 'REFUND') await settleVendorRefunds(requestId)
  return { skipped: outcome === 'SKIPPED' }
}

/** A small status read for the app after Checkout (also used when the callback was lost). */
export async function statusFor(id) {
  const { rows: [r] } = await query('SELECT vendor_payment_status, vendor_held_amount, final_price FROM sell_requests WHERE id = $1', [id])
  return { vendorPaymentStatus: r?.vendor_payment_status, heldAmount: money(r?.vendor_held_amount || 0), amountDue: money(r?.final_price || 0), funded: r?.vendor_payment_status === 'HELD' }
}

/** Resume a payment whose callback never reached us (app killed mid-Checkout): look the order up on Razorpay. */
export async function syncFunding(actor, id) {
  if (!onlinePaymentsReady()) return statusFor(id)
  const { rows } = await query(`SELECT razorpay_order_id FROM sell_razorpay_orders WHERE request_id = $1 AND status = 'CREATED' ORDER BY created_at DESC LIMIT 3`, [id])
  for (const o of rows) {
    try {
      const list = await razorpay.orders.fetchPayments(o.razorpay_order_id)
      const ok = (list.items || []).find((p) => ['captured', 'authorized'].includes(p.status))
      if (ok) await completeFunding(o.razorpay_order_id, ok.id, { source: 'SYNC' })
    } catch (err) { logger.warn({ err: err?.message, orderId: o.razorpay_order_id }, 'sell funding sync failed') }
  }
  return statusFor(id)
}

// ── Buyer refunds ───────────────────────────────────────────────────────

/**
 * Send every pending VENDOR_REFUND of a request back to the buyer's original Razorpay payment. Partial refunds are
 * supported (price drop). Refunds with no online payment behind them stay PROCESSING for finance.
 */
export async function settleVendorRefunds(requestId) {
  if (!onlinePaymentsReady()) return false
  const { rows } = await query(`SELECT * FROM sell_payments WHERE request_id = $1 AND kind = 'VENDOR_REFUND' AND status = 'PROCESSING' ORDER BY created_at`, [requestId])
  for (const row of rows) {
    const { rows: [fund] } = await query(
      `SELECT provider_ref FROM sell_payments WHERE request_id = $1 AND kind = 'VENDOR_FUNDING' AND status = 'CONFIRMED' AND provider_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [requestId])
    const paymentId = row.provider_ref || fund?.provider_ref
    if (!paymentId) continue
    try {
      // Safe to retry: look for a refund we already created for this row before creating another.
      const existing = await razorpay.payments.fetchMultipleRefund(paymentId).catch(() => ({ items: [] }))
      let refund = (existing.items || []).find((x) => x.notes?.sell_payment_id === row.id)
      if (!refund) refund = await razorpay.payments.refund(paymentId, { amount: paise(row.amount), speed: 'normal', notes: { sell_payment_id: row.id, sell_request_id: requestId } })
      await tx(async (client) => {
        await client.query(`UPDATE sell_payments SET status = 'PAID', method = 'RAZORPAY', reference = $2, provider_ref = $3, updated_at = NOW() WHERE id = $1 AND status = 'PROCESSING'`, [row.id, refund.id, paymentId])
        const { rows: left } = await client.query(`SELECT 1 FROM sell_payments WHERE request_id = $1 AND kind = 'VENDOR_REFUND' AND status = 'PROCESSING'`, [requestId])
        if (!left[0]) await client.query(`UPDATE sell_requests SET vendor_payment_status = 'REFUNDED', updated_at = NOW() WHERE id = $1 AND vendor_payment_status = 'REFUNDING'`, [requestId])
        await addEvent(client, requestId, 'VENDOR_REFUNDED', 'Buyer refunded', null, { reference: refund.id, amount: money(row.amount) })
      })
    } catch (err) {
      logger.error({ err: err?.error || err?.message, requestId, paymentRow: row.id }, 'sell refund failed — left for finance')
    }
  }
  return true
}

// ── Seller payouts (RazorpayX) ──────────────────────────────────────────

const xFetch = async (path, body, headers = {}) => {
  const auth = Buffer.from(`${getRazorpayKeyId()}:${getRazorpayKeySecret()}`).toString('base64')
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) { const e = new Error(json?.error?.description || `RazorpayX ${res.status}`); e.status = res.status; e.body = json; throw e }
  return json
}
export const _xFetch = { current: xFetch }   // swapped in tests

/** Send a UPI / bank payout through RazorpayX. Returns true when handed to RazorpayX, false when left for finance. */
export async function sendPayout(requestId) {
  if (!payoutsReady()) return false
  const { rows: [r] } = await query(`SELECT * FROM sell_requests WHERE id = $1 AND kind = 'SELL'`, [requestId])
  if (!r || r.payout_status !== 'PROCESSING' || !['UPI', 'BANK'].includes(r.payout_method) || !r.payout_details) return false
  const { rows: [pay] } = await query(`SELECT * FROM sell_payments WHERE request_id = $1 AND kind = 'CUSTOMER_PAYOUT' AND status = 'PROCESSING' ORDER BY created_at DESC LIMIT 1`, [requestId])
  if (!pay || pay.provider_ref) return false      // already handed over
  const d = JSON.parse(decryptSecret(r.payout_details))
  const call = _xFetch.current
  try {
    const { rows: [u] } = await query('SELECT name FROM users WHERE id = $1', [r.user_id])
    const name = text(d.holderName || u?.name || r.customer_name || 'Dealker seller', 80)
    const contact = await call('/contacts', { name, type: 'customer', reference_id: r.code })
    const fund = r.payout_method === 'UPI'
      ? await call('/fund_accounts', { contact_id: contact.id, account_type: 'vpa', vpa: { address: d.upiId } })
      : await call('/fund_accounts', { contact_id: contact.id, account_type: 'bank_account', bank_account: { name, ifsc: d.ifsc, account_number: d.accountNumber } })
    const out = await call('/payouts', {
      account_number: env.RAZORPAYX_ACCOUNT_NUMBER, fund_account_id: fund.id, amount: paise(pay.amount), currency: 'INR',
      mode: r.payout_method === 'UPI' ? 'UPI' : 'IMPS', purpose: 'payout', queue_if_low_balance: true, reference_id: r.code.slice(0, 40), narration: 'Dealker phone sale',
    }, { 'X-Payout-Idempotency': `sell-payout-${requestId}` })
    await query(`UPDATE sell_payments SET provider_ref = $2, updated_at = NOW() WHERE id = $1`, [pay.id, out.id])
    await tx(async (client) => addEvent(client, requestId, 'PAYOUT_SENT', 'Payment sent to your bank — waiting for confirmation', null, { payoutId: out.id }))
    if (out.status === 'processed') await applyPayoutResult(out)
    return true
  } catch (err) {
    logger.error({ err: err?.body || err?.message, requestId }, 'RazorpayX payout failed to start — left for finance')
    await tx(async (client) => addEvent(client, requestId, 'PAYOUT_AUTO_FAILED', 'Automatic payout did not start; finance will send it', null, { reason: text(err?.message, 200) })).catch(() => {})
    return false
  }
}

/** Apply a RazorpayX payout state (from a webhook or a poll). Idempotent. */
export async function applyPayoutResult(p) {
  const { rows: [pay] } = await query(`SELECT * FROM sell_payments WHERE kind = 'CUSTOMER_PAYOUT' AND provider_ref = $1`, [p.id])
  if (!pay) return false
  const journey = await import('./sell-journey.service.js')
  if (p.status === 'processed') {
    if (pay.status === 'PAID') return true
    await journey.markPayoutPaid(SYSTEM, pay.request_id, { reference: p.utr || p.id }).catch((err) => { if (err.code !== 'INVALID_STATE') throw err })
    return true
  }
  if (['failed', 'rejected', 'cancelled', 'reversed'].includes(p.status) && pay.status === 'PROCESSING') {
    await journey.failPayout(SYSTEM, pay.request_id, p.status_details?.description || `Payout ${p.status}`)
    return true
  }
  return false
}

/** Poll RazorpayX for a payout that is still pending (finance button / safety net if a webhook was missed). */
export async function syncPayout(requestId) {
  if (!payoutsReady()) return false
  const { rows: [pay] } = await query(`SELECT * FROM sell_payments WHERE request_id = $1 AND kind = 'CUSTOMER_PAYOUT' AND status = 'PROCESSING' AND provider_ref IS NOT NULL`, [requestId])
  if (!pay) return false
  return applyPayoutResult(await _xFetch.current(`/payouts/${pay.provider_ref}`))
}
