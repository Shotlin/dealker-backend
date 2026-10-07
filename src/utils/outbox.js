/**
 * Generic Transactional Outbox Helper for Meet Commerce Platform
 * Source of truth: Blueprint §04.4, ADR-001
 *
 * ARCHITECTURAL CONSTRAINTS:
 *   1. This module MUST NOT import or depend on any business domain modules
 *      (orders, vendors, warehouses, products).
 *   2. emitEvent MUST write strictly to the PostgreSQL outbox_events table
 *      inside the active database client transaction and return.
 *   3. emitEvent MUST NEVER publish events directly to BullMQ or network sockets
 *      inside HTTP transaction threads. Event publishing belongs exclusively
 *      to background worker pollers.
 *
 * @module utils/outbox
 */

import { logger } from '../config/logger.js'

/**
 * Emit a domain event to the transactional outbox table inside an active DB transaction.
 *
 * @param {import('pg').PoolClient} client Active PostgreSQL transaction client
 * @param {object} opts
 * @param {string} opts.eventType Event descriptor string (e.g. 'VENDOR_APPROVED', 'ORDER_PLACED')
 * @param {string} opts.aggregateType Domain entity type (e.g. 'VENDOR', 'ORDER', 'SUPPLY_BATCH')
 * @param {string} opts.aggregateId UUID of the target domain entity
 * @param {object} opts.payload Event payload object (MUST be non-empty object)
 * @param {string} [opts.correlationId] Optional UUID for request correlation tracing
 * @param {string} [opts.causationId] Optional UUID of triggering event
 * @returns {Promise<{ id: string, event_type: string, aggregate_type: string, aggregate_id: string, created_at: Date }>}
 */
export async function emitEvent(client, opts) {
  if (!client || typeof client.query !== 'function') {
    throw new Error('emitEvent requires an active database transaction client')
  }

  const { eventType, aggregateType, aggregateId, payload, correlationId, causationId } = opts

  if (!eventType || !aggregateType || !aggregateId) {
    throw new Error('emitEvent requires eventType, aggregateType, and aggregateId')
  }

  if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
    throw new Error('emitEvent payload MUST be a non-empty object to prevent silent event bugs')
  }

  const res = await client.query(
    `INSERT INTO outbox_events (
       event_type, aggregate_type, aggregate_id, payload, correlation_id, causation_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, event_type, aggregate_type, aggregate_id, created_at`,
    [
      eventType,
      aggregateType,
      aggregateId,
      JSON.stringify(payload),
      correlationId || null,
      causationId || null,
    ]
  )

  const record = res.rows[0]
  logger.debug(
    { eventId: record.id, eventType, aggregateType, aggregateId },
    'Transactional outbox event emitted to PostgreSQL'
  )

  return record
}
