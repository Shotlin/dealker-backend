/**
 * Core Outbox Re-export / Facade
 * Source of truth: Specification §11.1.11, WP-17
 * Re-exports the canonical transactional outbox writer from src/utils/outbox.js
 */

export { writeOutboxEvent, publishOutboxEvents, OUTBOX_STATUS } from '../../utils/outbox.js'
