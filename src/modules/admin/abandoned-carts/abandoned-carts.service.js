import crypto from 'node:crypto'
import { AdminAbandonedCartsRepository } from './abandoned-carts.repository.js'
import { NotificationsRepository } from '../../notifications/notifications.repository.js'
import { NotificationsService } from '../../notifications/notifications.service.js'
import { CouponsRepository } from '../../coupons/coupons.repository.js'
import { CouponsService } from '../../coupons/coupons.service.js'
import { buildTemplateVars, renderTemplate } from './abandoned-carts.templates.js'
import {
  ABANDONED_CART_REMINDER_COOLDOWN_MS,
  ABANDONED_CART_BULK_LIMIT,
  QUICK_COUPON_PRESETS,
  QUICK_COUPON_DEFAULT_VALID_HOURS,
  QUICK_COUPON_MAX_VALID_HOURS,
} from '../../../constants/abandonedCart.js'

const repo = new AdminAbandonedCartsRepository()
const couponsRepo = new CouponsRepository()
const couponsService = new CouponsService(couponsRepo)

const fail = (message, code) => ({ success: false, message, code })

function cooldownRemainingMs(episode, now = Date.now()) {
  if (!episode.lastReminderSentAt) return 0
  const elapsed = now - new Date(episode.lastReminderSentAt).getTime()
  return Math.max(0, ABANDONED_CART_REMINDER_COOLDOWN_MS - elapsed)
}

export class AdminAbandonedCartsService {
  async list({ page = 1, limit = 20, search, status, minValue, maxValue, sortBy, sortOrder }) {
    const offset = (page - 1) * limit
    return repo.findAll({ offset, limit, search, status, minValue, maxValue, sortBy, sortOrder })
  }

  async getSummary() {
    return repo.getSummary()
  }

  async getDetail(id) {
    const detail = await repo.findById(id)
    if (!detail) return null
    return { ...detail, reminderCooldownMs: cooldownRemainingMs(detail) }
  }

  getPresets() {
    return {
      presets: Object.entries(QUICK_COUPON_PRESETS).map(([key, p]) => ({ key, ...p })),
      defaultValidHours: QUICK_COUPON_DEFAULT_VALID_HOURS,
      maxValidHours: QUICK_COUPON_MAX_VALID_HOURS,
      reminderCooldownMinutes: Math.round(ABANDONED_CART_REMINDER_COOLDOWN_MS / 60000),
      placeholders: ['name', 'items', 'cartValue', 'topItem', 'code'],
    }
  }

  /**
   * Pushes a reminder via the app's real notification primitive (in-app row +
   * socket + FCM push) — the same one orders/wallet use. Only an OPEN cart can
   * be nudged, and never twice within the cooldown window.
   */
  async sendReminder(id, { title, body, imageUrl, deepLink }, adminUserId, fastify, extraVars = {}) {
    const episode = await repo.findById(id)
    if (!episode) return fail('Abandoned cart not found', 'NOT_FOUND')
    if (episode.status !== 'OPEN') {
      return fail(`This cart is already ${episode.status.toLowerCase()} — no reminder needed`, 'NOT_OPEN')
    }
    const wait = cooldownRemainingMs(episode)
    if (wait > 0) {
      return {
        ...fail(`A reminder was sent recently. Try again in ${Math.ceil(wait / 60000)} min.`, 'REMINDER_TOO_SOON'),
        retryAfterMs: wait,
      }
    }

    const vars = buildTemplateVars(episode, extraVars)
    const notifService = new NotificationsService(new NotificationsRepository(), fastify)
    const notification = await notifService.sendNotification(episode.user.id, {
      title: renderTemplate(title, vars),
      body: renderTemplate(body, vars),
      type: 'abandoned_cart',
      data: { abandonedCartId: id, deepLink: deepLink || '/cart', imageUrl: imageUrl || null },
    })

    await repo.recordNotification(id, { notificationId: notification.id, sentBy: adminUserId })
    return { success: true, notificationId: notification.id }
  }

  /** Same reminder to many carts; carts that can't be nudged are reported, not failed. */
  async sendBulkReminder(ids, payload, adminUserId, fastify) {
    const unique = [...new Set(ids)].slice(0, ABANDONED_CART_BULK_LIMIT)
    const sent = []
    const skipped = []
    for (const id of unique) {
      try {
        const r = await this.sendReminder(id, payload, adminUserId, fastify)
        if (r.success) sent.push(id)
        else skipped.push({ id, code: r.code, message: r.message })
      } catch (err) {
        skipped.push({ id, code: 'SEND_FAILED', message: err.message })
      }
    }
    return { success: true, requested: unique.length, sent: sent.length, skipped }
  }

  /**
   * Two modes over the EXISTING coupon engine (INDIVIDUAL targeting) — no new
   * discount logic:
   *   - create: brand-new coupon locked to this episode's customer.
   *   - assign: add the customer to an existing coupon's target list.
   */
  async issueCoupon(id, payload, actor) {
    const episode = await repo.findById(id)
    if (!episode) return fail('Abandoned cart not found', 'NOT_FOUND')
    const userId = episode.user.id

    if (payload.couponId) {
      const coupon = await couponsRepo.findById(payload.couponId)
      if (!coupon) return fail('Coupon not found', 'NOT_FOUND')
      await couponsRepo.addTargetUser(payload.couponId, userId)
      await repo.recordCoupon(id, { couponId: payload.couponId, issuedBy: actor.userId })
      return { success: true, couponId: payload.couponId, code: coupon.code }
    }

    const couponData = {
      ...payload,
      targetType: 'INDIVIDUAL',
      targetUserIds: [userId],
      createdBy: actor.userId,
    }
    delete couponData.couponId

    const result = await couponsService.create(couponData, actor)
    if (!result.success) return result

    await repo.recordCoupon(id, { couponId: result.coupon.id, issuedBy: actor.userId })
    return { success: true, couponId: result.coupon.id, code: result.coupon.code }
  }

  /**
   * One-click recovery: mint a single-use coupon from a preset, locked to this
   * customer, and (by default) tell them about it in the same step.
   */
  async sendQuickCoupon(id, { preset, validHours, notify = true }, actor, fastify) {
    const def = QUICK_COUPON_PRESETS[preset]
    if (!def) return fail('Unknown coupon preset', 'INVALID_PRESET')

    const episode = await repo.findById(id)
    if (!episode) return fail('Abandoned cart not found', 'NOT_FOUND')
    if (episode.status !== 'OPEN') {
      return fail(`This cart is already ${episode.status.toLowerCase()}`, 'NOT_OPEN')
    }

    const hours = Math.min(Math.max(Number(validHours) || QUICK_COUPON_DEFAULT_VALID_HOURS, 1), QUICK_COUPON_MAX_VALID_HOURS)
    const now = new Date()
    const validUntil = new Date(now.getTime() + hours * 3600 * 1000)

    // Unique, human-friendly code (retry on the rare collision).
    let code
    for (let i = 0; i < 5; i++) {
      const candidate = `COMEBACK${crypto.randomBytes(3).toString('hex').toUpperCase()}`
      if (!(await couponsRepo.findByCode(candidate))) { code = candidate; break }
    }
    if (!code) return fail('Could not generate a unique coupon code, try again', 'CODE_GENERATION_FAILED')

    const issued = await this.issueCoupon(id, {
      code,
      description: `Cart recovery: ${def.label}`,
      terms: `Valid only for you until ${validUntil.toLocaleString('en-IN')}. One use.`,
      discountType: def.discountType,
      discountValue: def.discountValue,
      minOrderAmount: def.minOrderAmount,
      maxDiscount: def.maxDiscount,
      grantsFreeDelivery: def.discountType === 'FREE_DELIVERY',
      usageLimit: 1,
      perUserLimit: 1,
      validFrom: now.toISOString(),
      validUntil: validUntil.toISOString(),
    }, actor)
    if (!issued.success) return issued

    let notificationId = null
    let notifyNote = null
    if (notify) {
      const note = await this.sendReminderIgnoringCooldown(id, {
        title: `${def.label} just for you 🎁`,
        body: `Hi {{name}}, your {{items}} item(s) worth {{cartValue}} are still in your cart. Use code {{code}} for ${def.label} — valid for ${hours}h.`,
        deepLink: '/cart',
      }, actor.userId, fastify, { code: issued.code })
      if (note.success) notificationId = note.notificationId
      else notifyNote = note.message
    }

    return { success: true, couponId: issued.couponId, code: issued.code, validUntil, notificationId, notifyNote }
  }

  // A coupon announcement is a different message from a plain nudge, so it
  // is exempt from the nudge cooldown (but still needs an OPEN cart).
  async sendReminderIgnoringCooldown(id, payload, adminUserId, fastify, extraVars) {
    const episode = await repo.findById(id)
    if (!episode) return fail('Abandoned cart not found', 'NOT_FOUND')
    const vars = buildTemplateVars(episode, extraVars)
    const notifService = new NotificationsService(new NotificationsRepository(), fastify)
    const notification = await notifService.sendNotification(episode.user.id, {
      title: renderTemplate(payload.title, vars),
      body: renderTemplate(payload.body, vars),
      type: 'abandoned_cart',
      data: { abandonedCartId: id, deepLink: payload.deepLink || '/cart', couponCode: extraVars?.code ?? null },
    })
    await repo.recordNotification(id, { notificationId: notification.id, sentBy: adminUserId })
    return { success: true, notificationId: notification.id }
  }
}
