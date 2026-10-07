/**
 * Auction worker — the clock behind auctions.
 *
 *   tick       every 5 s   start due auctions, close ended auctions
 *   slow-tick  every 60 s  payment deadlines + second-chance offers, order-payment
 *                          reconciliation, ending-soon reminders
 *
 * All the logic lives in auction-settlement.service (re-checked under row locks),
 * so a duplicated or retried job can never double-settle.
 */

import { logger } from '../config/logger.js'
import { tick } from '../modules/auctions/auction-settlement.service.js'

export function createAuctionProcessor() {
  return async function processAuctionJob(job) {
    const type = job?.data?.type || job?.name
    const result = await tick({ slow: type === 'slow-tick' })
    if (result.started || result.closed || (result.payments && (result.payments.sold || result.payments.defaulted || result.payments.released))) {
      logger.info({ action: 'auction_tick', type, result }, 'Auction tick did work')
    }
    return result
  }
}

export async function scheduleAuctionBeats(queue) {
  if (!queue) return
  await queue.add('tick', { type: 'tick' }, {
    repeat: { every: 5000 }, jobId: 'auction-tick', removeOnComplete: true, removeOnFail: true,
  })
  await queue.add('slow-tick', { type: 'slow-tick' }, {
    repeat: { every: 60_000 }, jobId: 'auction-slow-tick', removeOnComplete: true, removeOnFail: true,
  })
  logger.info({ action: 'auction_beats_registered' }, 'Auction beats registered (5s / 60s)')
}
