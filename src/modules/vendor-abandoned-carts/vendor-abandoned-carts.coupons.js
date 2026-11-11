/**
 * One-time product coupons from a vendor to a shopper who left that vendor's product in the cart.
 *
 * Rules (all enforced here, the app only shows them):
 *   - only for a product the vendor owns that is STILL in the shopper's live cart (B2C and B2B carts alike);
 *   - Percentage: 1–50 %.  Flat: at least ₹1 and at most half of that product's line total;
 *   - valid for 1, 3 or 7 days; usable ONCE by that shopper only, on that product only (other products in the
 *     cart get no discount); the vendor funds it (SHOP coupon: debited from the vendor on use);
 *   - max 3 coupons per cart per vendor and one live coupon per product;
 *   - the shopper must not have turned promotions off, and the daily push cap across all senders applies;
 *   - it lands in the shopper's Coupons list (INDIVIDUAL target) and a notification is sent.
 *
 * @module modules/vendor-abandoned-carts/vendor-abandoned-carts.coupons
 */
import crypto from 'node:crypto'
import { query } from '../../config/database.js'
import { CartRepository } from '../cart/cart.repository.js'
import { CouponsRepository } from '../coupons/coupons.repository.js'
import { NotificationsRepository } from '../notifications/notifications.repository.js'
import { NotificationsService } from '../notifications/notifications.service.js'
import { CUSTOMER_DAILY_CAP } from '../../constants/abandonedCart.js'
import * as repo from './vendor-abandoned-carts.repository.js'
import { VendorCartError } from './vendor-abandoned-carts.service.js'

const couponsRepo = new CouponsRepository()
const cartRepository = new CartRepository()

export const COUPON_RULES = Object.freeze({ maxPercent: 50, maxFlatShareOfLine: 0.5, validDays: [1, 3, 7], maxPerCart: 3 })

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const makeCode = () => `DK${Array.from(crypto.randomBytes(7), (b) => CHARS[b % CHARS.length]).join('')}`
const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const fmtDate = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })

/** Coupons this vendor sent for the cart, with live status. */
export async function couponsFor(vendorId, cartId) {
  const { rows } = await query(
    `SELECT v.id, v.product_id, v.product_name, v.discount_type, v.discount_value, v.created_at,
            c.code, c.valid_until, c.is_active, c.used_count
       FROM abandoned_cart_vendor_coupons v JOIN coupons c ON c.id = v.coupon_id
      WHERE v.abandoned_cart_id = $2 AND v.vendor_id = $1 ORDER BY v.created_at DESC`, [vendorId, cartId])
  const now = Date.now()
  return rows.map((r) => ({
    id: r.id,
    product_id: r.product_id,
    product_name: r.product_name,
    discount_type: r.discount_type,
    discount_value: Number(r.discount_value),
    code: r.code,
    valid_until: r.valid_until,
    created_at: r.created_at,
    status: r.used_count > 0 ? 'USED' : !r.is_active ? 'CANCELLED' : new Date(r.valid_until).getTime() < now ? 'EXPIRED' : 'ACTIVE',
  }))
}

/** What the vendor may offer right now (used by the detail screen to enable the button). */
export async function couponEligibility(vendorId, ep) {
  if (ep.status !== 'OPEN') return { can_send: false, reason: 'NOT_OPEN', message: 'This cart is no longer open — no coupon needed.' }
  if ((ep.notification_preferences || {}).promotions === false) {
    return { can_send: false, reason: 'OPTED_OUT', message: 'This customer has turned off promotional notifications.' }
  }
  const mine = await couponsFor(vendorId, ep.id)
  if (mine.length >= COUPON_RULES.maxPerCart) {
    return { can_send: false, reason: 'LIMIT_REACHED', message: `You have already sent ${COUPON_RULES.maxPerCart} coupons for this cart.` }
  }
  if ((await repo.customerPushesLast24h(ep.user_id)) >= CUSTOMER_DAILY_CAP) {
    return { can_send: false, reason: 'CUSTOMER_CAP', message: 'This customer has received several messages today. Try again tomorrow.' }
  }
  return { can_send: true }
}

export async function sendCoupon(vendorId, id, input = {}, { userId, fastify } = {}) {
  const type = String(input.discountType || '').toUpperCase()
  if (!['PERCENTAGE', 'FLAT'].includes(type)) throw new VendorCartError('VALIDATION', 'Choose a flat amount or a percentage', 422)
  const value = Number(input.value)
  const days = Number(input.validDays ?? 3)
  if (!COUPON_RULES.validDays.includes(days)) throw new VendorCartError('VALIDATION', 'Choose 1, 3 or 7 days of validity', 422)
  if (!Number.isFinite(value) || value <= 0) throw new VendorCartError('VALIDATION', 'Enter the discount', 422)

  const ep = await repo.findEpisode(vendorId, id)
  if (!ep) throw new VendorCartError('NOT_FOUND', 'Cart not found', 404)
  const line = (await repo.sliceItems(vendorId, id)).find((i) => i.product_id === input.productId)
  if (!line) throw new VendorCartError('NOT_YOUR_PRODUCT', 'You can only send a coupon for your own product in this cart', 403)

  // only a product still in the live cart
  const live = await cartRepository.getCart(ep.user_id, ep.price_mode === 'wholesale' ? 'wholesale' : 'retail')
  if (!live.some((l) => l.productId === line.product_id && l.shopId === line.shop_id)) {
    throw new VendorCartError('CART_CHANGED', 'The customer has already changed or finished this cart — no coupon needed.', 409)
  }

  const lineTotal = Number(line.line_total)
  if (type === 'PERCENTAGE') {
    if (value < 1 || value > COUPON_RULES.maxPercent) throw new VendorCartError('VALIDATION', `Percentage must be between 1 and ${COUPON_RULES.maxPercent}`, 422)
  } else {
    const max = Math.floor(lineTotal * COUPON_RULES.maxFlatShareOfLine)
    if (value < 1 || value > max) throw new VendorCartError('VALIDATION', `Flat discount must be between ₹1 and ${inr(max)} (half of this product's price in the cart)`, 422)
  }
  const amount = type === 'PERCENTAGE' ? Math.round(value * 100) / 100 : Math.round(value)

  const elig = await couponEligibility(vendorId, ep)
  if (!elig.can_send) throw new VendorCartError(elig.reason, elig.message, 409)
  const dup = (await couponsFor(vendorId, id)).find((c) => c.product_id === line.product_id && c.status === 'ACTIVE')
  if (dup) throw new VendorCartError('ALREADY_SENT', 'There is already a live coupon for this product in this cart.', 409)

  const shop = await repo.vendorName(vendorId)
  const validUntil = new Date(Date.now() + days * 86400000)
  const off = type === 'PERCENTAGE' ? `${amount}% off` : `${inr(amount)} off`

  let coupon = null
  for (let i = 0; i < 5 && !coupon; i++) {
    try {
      coupon = await couponsRepo.create({
        code: makeCode(),
        description: `${off} ${line.product_name} — a one-time offer from ${shop}`,
        terms: `Valid on ${line.product_name} only. One-time use, for your account only. Expires ${fmtDate(validUntil)}. Other items in your cart are not discounted.`,
        discountType: type,
        discountValue: amount,
        minOrderAmount: 0,
        usageLimit: 1,
        usageLimitTotal: 1,
        perUserLimit: 1,
        usageLimitPerUser: 1,
        validFrom: new Date(),
        validUntil,
        couponType: 'SHOP_COUPON',
        absorber: 'SHOP',
        shopId: line.shop_id,
        applicableProductIds: [line.product_id],
        targetType: 'INDIVIDUAL',
        targetUserIds: [ep.user_id],
        createdBy: userId || null,
      })
    } catch (err) {
      if (err.code !== '23505') throw err   // duplicate code → try another
    }
  }
  if (!coupon) throw new VendorCartError('SEND_FAILED', 'Could not create the coupon. Please try again.', 502)

  const { rows } = await query(
    `INSERT INTO abandoned_cart_vendor_coupons (abandoned_cart_id, vendor_id, coupon_id, product_id, product_name, discount_type, discount_value, sent_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [id, vendorId, coupon.id, line.product_id, line.product_name, type, amount, userId || null])

  try {
    const notif = await new NotificationsService(new NotificationsRepository(), fastify).sendNotification(ep.user_id, {
      title: `${off} ${line.product_name}`,
      body: `${shop} sent you a one-time coupon ${coupon.code}. Use it on ${line.product_name} in your cart before ${fmtDate(validUntil)}.`,
      type: 'coupon',
      data: { deepLink: '/cart', couponCode: coupon.code, priceMode: ep.price_mode, vendorId, source: 'vendor' },
    })
    await query(`UPDATE abandoned_cart_vendor_coupons SET notification_id = $2 WHERE id = $1`, [rows[0].id, notif.id])
  } catch {
    // The coupon exists and is in the shopper's list, but nothing was pushed: undo so the vendor is not charged a slot.
    await query(`DELETE FROM abandoned_cart_vendor_coupons WHERE id = $1`, [rows[0].id]).catch(() => {})
    await query(`UPDATE coupons SET is_active = FALSE WHERE id = $1`, [coupon.id]).catch(() => {})
    throw new VendorCartError('SEND_FAILED', 'Could not send the coupon. Please try again.', 502)
  }
  fastify?.emitAbandonedCartUpdate?.({ userId: ep.user_id, abandonedCartId: id, status: 'VENDOR_COUPON' })
  return { id: rows[0].id, code: coupon.code, valid_until: validUntil.toISOString() }
}

/** Withdraw an unused coupon. */
export async function cancelCoupon(vendorId, id, couponRowId) {
  const { rows } = await query(
    `SELECT v.coupon_id, c.used_count FROM abandoned_cart_vendor_coupons v JOIN coupons c ON c.id = v.coupon_id
      WHERE v.id = $3 AND v.vendor_id = $1 AND v.abandoned_cart_id = $2`, [vendorId, id, couponRowId])
  if (!rows[0]) throw new VendorCartError('NOT_FOUND', 'Coupon not found', 404)
  if (rows[0].used_count > 0) throw new VendorCartError('ALREADY_USED', 'This coupon has already been used.', 409)
  await query(`UPDATE coupons SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [rows[0].coupon_id])
  return { ok: true }
}
