// Feature: multi-vendor-system, task 13.6
// Event-loop blocking detector — logs a warning when the event loop is
// blocked for more than 100ms. Uses a high-resolution timer approach
// compatible with Node.js 16+.
//
// Implementation: A recurring `setTimeout(0)` measures the actual delay
// between scheduled and actual execution. If the delta exceeds the
// threshold (100ms), a structured warning is emitted via pino.
//
// This is intentionally lightweight — no native addons, no
// monitorEventLoopDelay histogram (requires perf_hooks and adds GC
// pressure on a 4GB box). The setInterval approach uses <1KB of memory
// and negligible CPU.

import { logger } from '../config/logger.js'

const BLOCK_THRESHOLD_MS = 100
const CHECK_INTERVAL_MS = 500

let monitorTimer = null

/**
 * Start the event-loop blocking detector.
 * Logs a warning when the event loop is blocked for >100ms.
 *
 * @returns {{ stop: () => void }} Handle to stop monitoring
 */
export function startEventLoopMonitor() {
  let lastCheck = process.hrtime.bigint()

  function check() {
    const now = process.hrtime.bigint()
    const elapsedMs = Number(now - lastCheck) / 1_000_000
    const blockTimeMs = elapsedMs - CHECK_INTERVAL_MS

    if (blockTimeMs > BLOCK_THRESHOLD_MS) {
      logger.warn(
        {
          blockTimeMs: Math.round(blockTimeMs),
          elapsedMs: Math.round(elapsedMs),
          threshold: BLOCK_THRESHOLD_MS,
          action: 'event_loop_blocked',
        },
        `Event loop blocked for ${Math.round(blockTimeMs)}ms (threshold: ${BLOCK_THRESHOLD_MS}ms)`
      )
    }

    lastCheck = process.hrtime.bigint()
    monitorTimer = setTimeout(check, CHECK_INTERVAL_MS)
    monitorTimer.unref() // Don't prevent process exit
  }

  // Initial schedule
  monitorTimer = setTimeout(check, CHECK_INTERVAL_MS)
  monitorTimer.unref()

  logger.info(
    { threshold: BLOCK_THRESHOLD_MS, interval: CHECK_INTERVAL_MS, action: 'event_loop_monitor_started' },
    'Event-loop blocking detector started'
  )

  return {
    stop() {
      if (monitorTimer) {
        clearTimeout(monitorTimer)
        monitorTimer = null
      }
    },
  }
}
