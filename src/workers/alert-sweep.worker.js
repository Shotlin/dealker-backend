/** Alert sweep — every 5 minutes: time-based alerts (auctions ending within the hour). Idempotent via dedupe keys. */
import { logger } from '../config/logger.js'
import { AlertsService } from '../modules/alerts/alerts.service.js'

const svc = new AlertsService()
let handle = null

async function run() {
  try {
    const r = await svc.sweep()
    if (r.raised) logger.info({ action: 'alert_sweep', ...r }, 'Alert sweep raised alerts')
  } catch (err) {
    logger.error({ err: err.message }, 'Alert sweep failed')
  }
}

export function startAlertSweeper() {
  if (handle) return
  handle = setInterval(run, 5 * 60 * 1000)
  handle.unref?.()
  setTimeout(run, 30_000).unref?.()
  logger.info('Alert sweeper started (every 5 min)')
}
