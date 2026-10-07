/**
 * Core Idempotency Re-export / Facade
 * Source of truth: Specification §11.1.7, WP-17
 * Re-exports the authoritative idempotency handler from src/utils/idempotency.js
 */

export { computeRequestHash, requireIdempotency } from '../../utils/idempotency.js'
