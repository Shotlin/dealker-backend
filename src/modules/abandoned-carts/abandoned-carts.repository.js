import { query, getClient } from '../../config/database.js'
import {
  ABANDONED_CART_EVENT_TYPE,
  ABANDONED_CART_EXPIRY_MS,
} from '../../constants/abandonedCart.js'

/**
 * Core write-path repository for the Abandoned Cart Management System.
 * Used by the sweep worker (src/workers/abandoned-cart.worker.js),
 * CartService (recovery detection), and OrdersService (conversion
 * detection). The admin-facing READ module lives separately at
 * src/modules/admin/abandoned-carts/ (mirrors the existing
 * notifications vs admin/notifications split).
 */
export class AbandonedCartsRepository {
  /**
   * Records (or refreshes) one user's abandonment episode + line-item
   * snapshot in a single self-contained transaction. The sweep worker
   * calls this once per candidate user inside its own try/catch, so one
   * user's failure can never roll back another's — deliberately NOT one
   * big batch transaction (unlike payment-expiry.worker.js, whose batch
   * shares a single stock-restore transaction by necessity; per-user
   * abandoned-cart processing has no such cross-user dependency).
   *
   * @param {string} userId
   * @param {{items: Array<object>, subtotal: number}} enrichedCart - shape returned by CartService.getCart()
   * @param {number} abandonedAtMs - epoch-ms from the cart-activity ZSET score
   * @param {{score: number, breakdown: object}|null} priorityScoring - only computed on first detection (pass null on resweep — ignored when an OPEN row already exists)
   * @returns {Promise<{id: string, isNew: boolean}>}
   */
  async recordAbandonment(userId, enrichedCart, abandonedAtMs, priorityScoring) {
    const client = await getClient()
    try {
      await client.query('BEGIN')

      const { rows: [existing] } = await client.query(
        `SELECT id FROM abandoned_carts WHERE user_id = $1 AND status = 'OPEN' FOR UPDATE`,
        [userId]
      )

      const itemCount = enrichedCart.items.length
      const totalQuantity = enrichedCart.items.reduce((sum, i) => sum + i.quantity, 0)
      const cartValue = enrichedCart.subtotal

      let episodeId
      let isNew = false

      if (existing) {
        episodeId = existing.id
        await client.query(
          `UPDATE abandoned_carts
             SET item_count = $2, total_quantity = $3, cart_value = $4, updated_at = NOW()
           WHERE id = $1`,
          [episodeId, itemCount, totalQuantity, cartValue]
        )
        await client.query(
          `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type)
           VALUES ($1, $2, 'SYSTEM')`,
          [episodeId, ABANDONED_CART_EVENT_TYPE.RESWEPT]
        )
      } else {
        isNew = true
        const score = priorityScoring?.score ?? 0
        const breakdown = priorityScoring?.breakdown ?? {}
        const { rows: [inserted] } = await client.query(
          `INSERT INTO abandoned_carts
             (user_id, status, abandoned_at, item_count, total_quantity, cart_value, priority_score, priority_breakdown)
           VALUES ($1, 'OPEN', to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7)
           RETURNING id`,
          [userId, abandonedAtMs, itemCount, totalQuantity, cartValue, score, JSON.stringify(breakdown)]
        )
        episodeId = inserted.id
        await client.query(
          `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type)
           VALUES ($1, $2, 'SYSTEM')`,
          [episodeId, ABANDONED_CART_EVENT_TYPE.DETECTED]
        )
      }

      // Replace the line-item snapshot wholesale — cart sizes are small
      // (a handful of items), so delete-then-reinsert is simpler and cheap
      // compared to a diffing upsert.
      await client.query(`DELETE FROM abandoned_cart_items WHERE abandoned_cart_id = $1`, [episodeId])
      for (const item of enrichedCart.items) {
        await client.query(
          `INSERT INTO abandoned_cart_items
             (abandoned_cart_id, product_id, shop_id, product_name, product_thumbnail_url,
              product_unit, quantity, unit_price, list_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            episodeId,
            item.productId,
            item.shopId,
            item.name,
            item.thumbnailUrl || null,
            item.unit || null,
            item.quantity,
            item.effectivePrice,
            item.price,
            item.lineTotal,
          ]
        )
      }

      await client.query('COMMIT')
      return { id: episodeId, isNew }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Flips a user's OPEN episode (if any) to RECOVERED — called immediately
   * from CartService after a successful addItem/updateItem/removeItem, not
   * deferred to the next sweep. Harmless no-op (0 rows) when there's no
   * open episode, which is the common case for most cart activity.
   */
  async markRecoveredByUserId(userId) {
    const { rows: [row] } = await query(
      `UPDATE abandoned_carts SET status = 'RECOVERED', recovered_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status = 'OPEN'
       RETURNING id`,
      [userId]
    )
    if (row) {
      await query(
        `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id)
         VALUES ($1, 'RECOVERED', 'CUSTOMER', $2)`,
        [row.id, userId]
      )
    }
    return row || null
  }

  /**
   * Flips a user's OPEN episode (if any) to CONVERTED — called from
   * OrdersService right after an order's transaction commits.
   */
  async markConvertedByUserId(userId, orderId) {
    const { rows: [row] } = await query(
      `UPDATE abandoned_carts SET status = 'CONVERTED', converted_at = NOW(), converted_order_id = $2, updated_at = NOW()
       WHERE user_id = $1 AND status = 'OPEN'
       RETURNING id`,
      [userId, orderId]
    )
    if (row) {
      await query(
        `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id, metadata)
         VALUES ($1, 'CONVERTED', 'CUSTOMER', $2, $3)`,
        [row.id, userId, JSON.stringify({ orderId })]
      )
    }
    return row || null
  }

  /**
   * Closes a user's OPEN episode as EXPIRED with a reason (e.g. the customer
   * emptied the cart themselves), so it stops appearing as recoverable.
   */
  async closeOpenByUserId(userId, reason) {
    const { rows: [row] } = await query(
      `UPDATE abandoned_carts SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status = 'OPEN'
       RETURNING id`,
      [userId]
    )
    if (row) {
      await query(
        `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id, metadata)
         VALUES ($1, 'EXPIRED', 'CUSTOMER', $2, $3)`,
        [row.id, userId, JSON.stringify({ reason })]
      )
    }
    return row || null
  }

  /**
   * Closes any OPEN episode that's been sitting past the expiry window —
   * run once per sweep tick. Returns the ids closed, purely for logging.
   */
  async expireStale() {
    const seconds = Math.floor(ABANDONED_CART_EXPIRY_MS / 1000)
    const { rows } = await query(
      `UPDATE abandoned_carts
         SET status = 'EXPIRED', expired_at = NOW(), updated_at = NOW()
       WHERE status = 'OPEN'
         AND abandoned_at < NOW() - make_interval(secs => $1)
       RETURNING id`,
      [seconds]
    )
    if (rows.length > 0) {
      const values = rows.map((_, i) => `($${i + 1}, 'EXPIRED', 'SYSTEM')`).join(',')
      await query(
        `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type) VALUES ${values}`,
        rows.map((r) => r.id)
      )
    }
    return rows.map((r) => r.id)
  }

  /**
   * Single-user lifetime value — same aggregate shape as
   * admin/customers/customers.repository.js's getLTV(), scoped to one
   * user instead of a top-100 ranking. Deliberately duplicated rather
   * than importing AdminCustomersRepository from a core module (that
   * would be a core → admin dependency, an architecture smell).
   */
  async getCustomerLTV(userId) {
    const { rows: [row] } = await query(
      `SELECT COALESCE(SUM(total_payable), 0) AS ltv, COUNT(*)::int AS order_count
       FROM orders WHERE customer_id = $1 AND status = 'DELIVERED'`,
      [userId]
    )
    return { ltv: parseFloat(row.ltv), orderCount: row.order_count }
  }

  /**
   * Recovered-or-converted ratio over the user's last 10 CLOSED episodes.
   * Returns null (not 0) when the user has no closed episodes yet, so the
   * priority-score formula can apply a neutral default instead of
   * penalizing brand-new abandoners who simply have no history.
   */
  async getUserRecoveryRate(userId) {
    const { rows } = await query(
      `SELECT status FROM abandoned_carts
       WHERE user_id = $1 AND status != 'OPEN'
       ORDER BY created_at DESC LIMIT 10`,
      [userId]
    )
    if (rows.length === 0) return null
    const recovered = rows.filter((r) => r.status === 'RECOVERED' || r.status === 'CONVERTED').length
    return recovered / rows.length
  }

  async logEvent(abandonedCartId, eventType, { actorType = 'SYSTEM', actorId = null, metadata = {} } = {}) {
    await query(
      `INSERT INTO abandoned_cart_events (abandoned_cart_id, event_type, actor_type, actor_id, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [abandonedCartId, eventType, actorType, actorId, JSON.stringify(metadata)]
    )
  }
}
