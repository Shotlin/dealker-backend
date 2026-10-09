/**
 * Subscription worker — hourly sweep: marks lapsed subscriptions EXPIRED,
 * warns about ones ending within a week. Idempotent and advisory-locked, so
 * several instances (or a restart) can never double-process.
 */
import { logger } from '../config/logger.js'
import { SubscriptionsService } from '../modules/subscriptions/subscriptions.service.js'

const svc = new SubscriptionsService()
const EVERY_MS = 60 * 60 * 1000
let handle = null

async function run() {
  try {
    const r = await svc.sweep()
    if (r.expired || r.expiring) logger.info({ action: 'subscription_sweep', ...r }, 'Subscription sweep did work')
  } catch (err) {
    logger.error({ err: err.message }, 'Subscription sweep failed')
  }
}

export function startSubscriptionSweeper() {
  if (handle) return
  handle = setInterval(run, EVERY_MS)
  handle.unref?.()
  setTimeout(run, 15_000).unref?.()
  logger.info('Subscription sweeper started (hourly)')
}
