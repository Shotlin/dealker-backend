/**
 * A vendor buys or renews a subscription plan online.
 *   plans()   → what can be bought
 *   checkout() → Razorpay order for tier + cycle
 *   verify()  → checks the payment signature, then activates the plan (stacks onto the current expiry)
 *
 * Activation goes through SubscriptionsService.assign(), so history, events, renewals and listing
 * limits behave exactly as when an admin assigns a plan.
 *
 * @module modules/subscriptions/subscription-purchase
 */

import crypto from 'node:crypto'
import { query, getClient } from '../../config/database.js'
import { logger } from '../../config/logger.js'
import { razorpay, getRazorpayKeyId, getRazorpayKeySecret } from '../../config/razorpay.js'

const BUYABLE = ['PAID', 'PREMIUM', 'UNLIMITED']
const CYCLES = ['MONTHLY', 'YEARLY']

const httpError = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code })

export class SubscriptionPurchase {
  constructor(subscriptions) {
    this.subscriptions = subscriptions
  }

  /** Active paid plans a vendor can choose from. */
  async plans() {
    const { rows } = await query(
      `SELECT tier, name, description, price_monthly, price_yearly, listing_limit, features
         FROM subscription_plans WHERE is_active AND tier = ANY($1) ORDER BY sort_order`, [BUYABLE])
    return rows.map((r) => ({
      tier: r.tier, name: r.name, description: r.description,
      priceMonthly: Number(r.price_monthly), priceYearly: Number(r.price_yearly),
      listingLimit: r.listing_limit, features: Array.isArray(r.features) ? r.features : [],
    }))
  }

  async checkout(vendorId, userId, { tier, cycle = 'MONTHLY' }) {
    tier = String(tier || '').toUpperCase()
    cycle = String(cycle || '').toUpperCase()
    if (!BUYABLE.includes(tier)) throw httpError(400, 'Choose a paid plan', 'VALIDATION')
    if (!CYCLES.includes(cycle)) throw httpError(400, 'Choose monthly or yearly billing', 'VALIDATION')
    if (!razorpay) throw httpError(503, 'Online payments are not available right now', 'PAYMENTS_OFF')

    const plan = (await query(`SELECT * FROM subscription_plans WHERE tier = $1 AND is_active`, [tier])).rows[0]
    if (!plan) throw httpError(409, 'This plan is not available right now', 'PLAN_INACTIVE')
    const amount = Number(cycle === 'YEARLY' ? plan.price_yearly : plan.price_monthly)
    if (!(amount > 0)) throw httpError(409, 'This plan has no price set — contact support', 'NO_PRICE')

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `sub_${Date.now()}`,
      notes: { purpose: 'vendor_subscription', vendorId, tier, cycle },
    })
    const { rows } = await query(
      `INSERT INTO subscription_purchases (vendor_id, user_id, tier, cycle, amount, razorpay_order_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [vendorId, userId, tier, cycle, amount, order.id])
    logger.info({ vendorId, tier, cycle, amount, orderId: order.id }, 'Subscription checkout created')
    return { purchaseId: rows[0].id, razorpayOrderId: order.id, amount, currency: 'INR', keyId: getRazorpayKeyId(), tier, cycle, planName: plan.name }
  }

  /** Verify the Razorpay signature and activate the plan, exactly once. */
  async verify(vendorId, userId, { orderId, paymentId, signature }) {
    if (!orderId || !paymentId || !signature) throw httpError(400, 'Missing payment details', 'VALIDATION')
    const client = await getClient()
    let purchase
    try {
      await client.query('BEGIN')
      purchase = (await client.query(
        `SELECT * FROM subscription_purchases WHERE razorpay_order_id = $1 FOR UPDATE`, [orderId])).rows[0]
      if (!purchase || purchase.vendor_id !== vendorId) throw httpError(404, 'Payment not found', 'NOT_FOUND')
      if (purchase.status === 'PAID') { await client.query('COMMIT'); return this.#activate(vendorId, userId, purchase) }

      const expected = crypto.createHmac('sha256', getRazorpayKeySecret()).update(`${orderId}|${paymentId}`).digest('hex')
      const ok = expected.length === String(signature).length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)))
      if (!ok) {
        await client.query(`UPDATE subscription_purchases SET status = 'FAILED' WHERE id = $1`, [purchase.id])
        await client.query('COMMIT')
        logger.warn({ vendorId, orderId }, 'Subscription payment signature mismatch')
        throw httpError(400, 'Payment verification failed', 'BAD_SIGNATURE')
      }
      await client.query(
        `UPDATE subscription_purchases SET status = 'PAID', razorpay_payment_id = $2, paid_at = NOW() WHERE id = $1`,
        [purchase.id, paymentId])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    return this.#activate(vendorId, userId, { ...purchase, razorpay_payment_id: paymentId })
  }

  /** Money is captured — activate. Safe to call again: a plan already activated for this payment is left alone. */
  async #activate(vendorId, userId, purchase) {
    const ref = purchase.razorpay_payment_id
    const done = (await query(`SELECT 1 FROM vendor_subscriptions WHERE vendor_id = $1 AND payment_ref = $2 LIMIT 1`, [vendorId, ref])).rows[0]
    if (!done) {
      // assign() stacks a same-plan renewal onto the current expiry
      await this.subscriptions.assign(vendorId, {
        tier: purchase.tier, cycle: purchase.cycle, amountPaid: Number(purchase.amount),
        paymentRef: ref, notes: 'Bought in the vendor app',
      }, userId)
      logger.info({ vendorId, tier: purchase.tier, cycle: purchase.cycle, ref }, 'Subscription activated from payment')
    }
    return this.subscriptions.me(vendorId)
  }
}
