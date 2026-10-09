/**
 * Promo-campaign worker — every minute: start campaigns whose time has come,
 * end the ones that are over (reverting their prices and sections). The
 * lifecycle methods claim the status atomically (UPDATE … WHERE status = …),
 * so extra instances or retries can never double-apply.
 */
import { logger } from '../config/logger.js'
import { CampaignsService } from '../modules/promo-campaigns/campaigns.service.js'

const svc = new CampaignsService()
let handle = null

async function run() {
  try {
    const r = await svc.tick()
    if (r.started || r.ended || r.failed) logger.info({ action: 'promo_campaign_tick', ...r }, 'Promo campaign tick did work')
  } catch (err) {
    logger.error({ err: err.message }, 'Promo campaign tick failed')
  }
}

export function startPromoCampaignWorker() {
  if (handle) return
  handle = setInterval(run, 60_000)
  handle.unref?.()
  setTimeout(run, 20_000).unref?.()
  logger.info('Promo campaign worker started (every 60s)')
}
