/**
 * Sell-request evidence cleanup — hourly: deletes uploads that were never attached to a request
 * (abandoned forms, failed submits) once they are 24 h old, files included. Evidence attached to a
 * request is never touched (and the database refuses to delete it). Safe to run on several instances.
 */
import { logger } from '../config/logger.js'
import { purgeOrphanMedia } from '../modules/sell-requests/evidence.service.js'

const EVERY_MS = 60 * 60 * 1000
let handle = null

async function run() {
  try {
    const n = await purgeOrphanMedia()
    if (n) logger.info({ action: 'evidence_cleanup', removed: n }, 'Removed abandoned evidence uploads')
  } catch (err) {
    logger.error({ err: err.message }, 'Evidence cleanup failed')
  }
}

export function startEvidenceCleanup() {
  if (handle) return
  handle = setInterval(run, EVERY_MS)
  handle.unref?.()
  setTimeout(run, 30_000).unref?.()
  logger.info('Evidence cleanup started (hourly)')
}
