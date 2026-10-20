/**
 * In-app payment of a repair by the customer: Razorpay Checkout (UPI / card / netbanking) or the Dealker wallet.
 * Every verified payment ends in the same idempotent `applyPayment`, which appends to `repair_payments`
 * exactly like a payment the shop records by hand — so due amounts, delivery gating and invoices need no changes.
 *
 * @module modules/repairs/repairs.pay
 */
import crypto from 'node:crypto'
import { query } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret } from '../../config/razorpay.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { money } from './repairs.engine.js'
import { RepairError, addEvent, amountDue, getManage, lock, text, tx } from './repairs.service.js'

const walletRepo = new WalletRepository()
const PAYABLE = ['ESTIMATE_APPROVED', 'IN_REPAIR', 'QC_PENDING', 'REPAIRED', 'READY_FOR_DELIVERY']

export const onlinePaymentsReady = () => Boolean(razorpay && getRazorpayKeyId() && getRazorpayKeySecret())

/** What the customer should pay right now: the advance first, then the balance. */
export function dueNow(r) {
  if (!PAYABLE.includes(r.status)) return null
  const due = amountDue(r)
  if (due <= 0) return null
  const advanceLeft = r.status === 'ESTIMATE_APPROVED'
    ? Math.max(0, money.rupees(money.paise(r.advance_required) - money.paise(r.amount_paid)))
    : 0
  return advanceLeft > 0 ? { kind: 'ADVANCE', amount: advanceLeft } : { kind: 'BALANCE', amount: due }
}

const customerOnly = (actor) => {
  if (actor.kind !== 'CUSTOMER') throw new RepairError('FORBIDDEN', 'Only the customer can pay here', 403)
}

/** Amount + the payment methods available (online needs Razorpay keys; wallet needs the balance). */
export async function options(actor, id) {
  customerOnly(actor)
  const { rows } = await query('SELECT * FROM repair_requests WHERE id = $1 AND user_id = $2', [id, actor.userId])
  const r = rows[0]
  if (!r) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
  const due = dueNow(r)
  const { rows: w } = await query('SELECT balance FROM wallets WHERE user_id = $1', [actor.userId])
  return {
    total: Number(r.approved_total ?? 0), paid: Number(r.amount_paid), due: Number(amountDue(r)),
    payNow: due ? { kind: due.kind, amount: due.amount } : null,
    methods: { online: onlinePaymentsReady(), wallet: true, atShop: true },
    walletBalance: Number(w[0]?.balance ?? 0),
  }
}

export async function createOrder(actor, id) {
  customerOnly(actor)
  if (!onlinePaymentsReady()) throw new RepairError('PAYMENTS_UNAVAILABLE', 'Online payments are not available right now', 503)
  const { rows } = await query('SELECT * FROM repair_requests WHERE id = $1 AND user_id = $2', [id, actor.userId])
  const r = rows[0]
  if (!r) throw new RepairError('NOT_FOUND', 'Repair request not found', 404)
  const due = dueNow(r)
  if (!due) throw new RepairError('INVALID_STATE', 'Nothing is due on this repair right now', 409)
  const { rows: open } = await query(`SELECT * FROM repair_razorpay_orders WHERE request_id = $1 AND status = 'CREATED' AND amount = $2 AND kind = $3 ORDER BY created_at DESC LIMIT 1`, [id, due.amount, due.kind])
  let order = open[0]
  if (!order) {
    let rzp
    try {
      rzp = await razorpay.orders.create({ amount: money.paise(due.amount), currency: 'INR', receipt: `rep-${r.code}`.slice(0, 40), notes: { kind: 'REPAIR', repair_id: id, code: r.code, part: due.kind } })
    } catch (err) {
      logger.error({ err: err?.error || err?.message, repairId: id }, 'repair payment: Razorpay order creation failed')
      throw new RepairError('PAYMENTS_UNAVAILABLE', 'Could not start the payment. Please try again.', 502)
    }
    const ins = await query(`INSERT INTO repair_razorpay_orders (request_id, user_id, razorpay_order_id, kind, amount) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [id, actor.userId, rzp.id, due.kind, due.amount])
    order = ins.rows[0]
  }
  return { keyId: getRazorpayKeyId(), orderId: order.razorpay_order_id, amount: money.paise(due.amount), amountRupees: due.amount, currency: 'INR', name: 'Dealker', description: `Repair ${r.code}`, kind: due.kind }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''), 'utf8'), y = Buffer.from(String(b ?? ''), 'utf8')
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

/** Insert the payment once (idempotent on the key) and bring `amount_paid` up to date. */
async function applyPayment(client, r, actor, { kind, method, amount, reference, key, note }) {
  const { rows: dup } = await client.query('SELECT 1 FROM repair_payments WHERE request_id = $1 AND idempotency_key = $2', [r.id, key])
  if (dup[0]) return false
  if (money.paise(amount) > money.paise(amountDue(r))) throw new RepairError('OVERPAYMENT', `Only ₹${amountDue(r)} is due`, 409, { due: amountDue(r) })
  await client.query(
    `INSERT INTO repair_payments (request_id, kind, method, amount, reference, idempotency_key, recorded_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [r.id, kind, method, amount, reference || null, key, actor.userId, note || null])
  await client.query('UPDATE repair_requests SET amount_paid = amount_paid + $2, updated_at = NOW() WHERE id = $1', [r.id, amount])
  await addEvent(client, r.id, 'PAYMENT', `Received ₹${amount} (${method.toLowerCase()}) — paid in the app`, actor, { meta: { kind, method, amount } })
  return true
}

export async function verifyOnline(actor, id, input = {}) {
  customerOnly(actor)
  const orderId = text(input.razorpayOrderId, 64), paymentId = text(input.razorpayPaymentId, 64), signature = text(input.razorpaySignature, 128)
  if (!orderId || !paymentId || !signature) throw new RepairError('VALIDATION', 'Payment details are incomplete', 422)
  const { rows } = await query('SELECT * FROM repair_razorpay_orders WHERE razorpay_order_id = $1 AND request_id = $2 AND user_id = $3', [orderId, id, actor.userId])
  const o = rows[0]
  if (!o) throw new RepairError('NOT_FOUND', 'Payment not found', 404)
  const expected = crypto.createHmac('sha256', getRazorpayKeySecret()).update(`${orderId}|${paymentId}`).digest('hex')
  if (!safeEqual(expected, signature)) throw new RepairError('PAYMENT_VERIFICATION_FAILED', 'We could not verify this payment. If money was deducted it will be refunded automatically.', 400)
  if (o.status !== 'PAID') {
    // Never trust the client: ask Razorpay itself.
    let p = await razorpay.payments.fetch(paymentId)
    if (p.order_id !== orderId || Number(p.amount) !== money.paise(o.amount)) throw new RepairError('PAYMENT_VERIFICATION_FAILED', 'This payment does not match the order', 400)
    if (p.status === 'authorized') p = await razorpay.payments.capture(paymentId, money.paise(o.amount), 'INR')
    if (p.status !== 'captured') throw new RepairError('PAYMENT_NOT_COMPLETE', `The payment is ${p.status}`, 409)
    const method = p.method === 'upi' ? 'UPI' : p.method === 'card' ? 'CARD' : 'BANK'
    await tx(async (client) => {
      const { rows: [row] } = await client.query('SELECT * FROM repair_razorpay_orders WHERE id = $1 FOR UPDATE', [o.id])
      if (row.status === 'PAID') return
      const r = await lock(client, id, actor)
      await client.query(`UPDATE repair_razorpay_orders SET status = 'PAID', razorpay_payment_id = $2, updated_at = NOW() WHERE id = $1`, [o.id, paymentId])
      await applyPayment(client, r, actor, { kind: o.kind, method, amount: Number(o.amount), reference: paymentId, key: `rzp-${paymentId}` })
    })
  }
  return getManage(actor, id)
}

export async function payWallet(actor, id, input = {}) {
  customerOnly(actor)
  await tx(async (client) => {
    const r = await lock(client, id, actor)
    const due = dueNow(r)
    if (!due) throw new RepairError('INVALID_STATE', 'Nothing is due on this repair right now', 409)
    const key = text(input.idempotencyKey, 80)
    if (key.length < 8) throw new RepairError('VALIDATION', 'idempotencyKey (8–80 characters) is required', 422)
    const wallet = await walletRepo.getForUpdate(client, actor.userId)
    if (!wallet || Number(wallet.balance) < due.amount) throw new RepairError('INSUFFICIENT_WALLET', 'Your wallet balance is too low', 409, { balance: wallet ? Number(wallet.balance) : 0, needed: due.amount })
    const { rows: dup } = await client.query('SELECT 1 FROM repair_payments WHERE request_id = $1 AND idempotency_key = $2', [id, `wallet-${key}`])
    if (dup[0]) return
    await walletRepo.debit(client, wallet.id, due.amount, `Repair ${r.code}`, r.id, { subType: 'REPAIR', sourceId: r.id })
    await applyPayment(client, r, actor, { kind: due.kind, method: 'WALLET', amount: due.amount, reference: null, key: `wallet-${key}` })
  })
  return getManage(actor, id)
}
