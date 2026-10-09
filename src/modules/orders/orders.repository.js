/**
 * Orders Repository — Data Access Layer for Orders, Status History & Fulfilment Tasks
 * Source of truth: Blueprint §06.7, Phase 8
 *
 * @module modules/orders/orders.repository
 */

import { query } from '../../config/database.js'

export class OrdersRepository {
  /**
   * Allocate an order number inside the caller's transaction.  The sequence
   * table makes simultaneous checkouts safe while keeping the printed number
   * useful to customers and store staff: FC-HQC-YYYYMMDD-0001.
   */
  async generateCheckoutOrderNumber(client, shopId) {
    const { rows: shops } = await client.query(
      // 'STR' (3 chars), not the old 'SHOP' (4) — with an 8-digit date and
      // 4-digit sequence, only a 3-char-or-shorter prefix keeps
      // "FC-<prefix>-YYYYMMDD-NNNN" at or under the 20-char column limit;
      // 'SHOP' itself silently overflowed it (caught by this fix's own
      // regression test).
      `SELECT COALESCE(NULLIF(order_prefix, ''), 'STR') AS order_prefix
         FROM shops WHERE id = $1 FOR SHARE`,
      [shopId]
    )
    if (!shops[0]) throw new Error('Store not found for order')

    const { rows } = await client.query(
      // `order_date::text` forces Postgres itself to format the DATE as
      // 'YYYY-MM-DD' before it ever reaches node-postgres. Without the
      // cast, `pg`'s default type parser (OID 1082) returns a native JS
      // Date object; `String(dateObject)` then stringifies as
      // "Wed Sep 23 2026 00:00:00 GMT+0000 (...)" — no dashes for
      // `.replaceAll('-','')` to strip, and `.slice(0,10)` grabs
      // "Wed Sep 23" (10 chars, with a space) instead of "20260923".
      // The resulting order number ("FC-KOL-Wed Sep 23-0001", 22 chars)
      // always overflowed `orders.order_number VARCHAR(20)` — every
      // single order placement, for every store, on every day, failed
      // on this INSERT with a raw "value too long for type character
      // varying(20)" surfaced to the customer as "Internal server error".
      `INSERT INTO order_number_sequences (shop_id, order_date, last_value)
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (shop_id, order_date)
       DO UPDATE SET last_value = order_number_sequences.last_value + 1
       RETURNING order_date::text, last_value`,
      [shopId]
    )
    const date = rows[0].order_date.replaceAll('-', '')
    const sequence = String(rows[0].last_value).padStart(4, '0')
    const orderNumber = `FC-${shops[0].order_prefix}-${date}-${sequence}`
    // Belt-and-braces: a shop with a longer order_prefix (a real risk once
    // more stores exist — see §7.2 point 2 in CLAUDE.md) must fail with a
    // clear, actionable error instead of the same opaque DB overflow this
    // whole fix was written to eliminate.
    if (orderNumber.length > 20) {
      throw new Error(
        `Generated order number "${orderNumber}" exceeds 20 characters — shorten shops.order_prefix for this store (currently "${shops[0].order_prefix}").`
      )
    }
    return orderNumber
  }

  /** Create a store-scoped checkout order and its immutable item snapshots. */
  async createCheckoutOrder(client, data) {
    let orderRow = null
    if (data.itemsOnly) {
      // Marketplace mode: the PARENT order row already exists; this call
      // only snapshots the seller group's items against the parent order
      // and the seller order that owns them (§7 — every order item belongs
      // to exactly one seller order).
      orderRow = { id: data.parentOrderId }
    } else {
      const { rows } = await client.query(
        `INSERT INTO orders (
          order_number, customer_id, shop_id, status, items,
          subtotal, discount_amount, loyalty_redeemed_amount,
          delivery_fee, platform_fee, tax_amount, total_payable,
          payment_method, payment_status, coupon_code, delivery_address,
          delivery_notes, estimated_delivery,
          wallet_amount, wallet_debited, client_order_ref
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
        )
        RETURNING *`,
        [
          data.orderNumber, data.customerId, data.shopId, data.status,
          JSON.stringify(data.items), data.subtotal, data.discountAmount || 0,
          0, data.deliveryFee || 0, data.platformFee || 0, data.taxAmount || 0,
          data.totalPayable, data.paymentMethod, data.paymentStatus,
          data.couponCode || null, JSON.stringify(data.deliveryAddress),
          data.deliveryNotes || null, data.estimatedDelivery || null,
          data.walletAmount || 0, !!data.walletDebited, data.clientOrderRef || null,
        ]
      )
      orderRow = rows[0]
    }
    const orderId = orderRow.id

    // itemIds[i] corresponds 1:1 to data.items[i] — the caller (placeOrder)
    // uses this to attach inventory-lot allocations to the right row
    // without a second round trip.
    const itemIds = []
    for (const item of data.items) {
      const { rows: itemRows } = await client.query(
        `INSERT INTO order_items (
          order_id, product_id, product_name, quantity, unit_price, subtotal,
          product_snapshot, shop_product_id, shop_id, seller_order_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id`,
        [
          orderId, item.productId, item.name, item.quantity, item.price,
          item.total, JSON.stringify(item), item.shopProductId || null,
          data.shopId, data.sellerOrderId || null,
        ]
      )
      itemIds.push(itemRows[0].id)
    }
    return { ...orderRow, _orderItemIds: itemIds }
  }

  /**
   * Parent (marketplace) order number: MK-YYYYMMDD-NNNNN. Allocated inside
   * the caller's transaction; a date-keyed sequence keeps concurrent
   * checkouts safe without shop scoping.
   */
  async generateMarketplaceOrderNumber(client) {
    const { rows } = await client.query(
      `INSERT INTO marketplace_order_sequences (order_date, last_value)
       VALUES (CURRENT_DATE, 1)
       ON CONFLICT (order_date)
       DO UPDATE SET last_value = marketplace_order_sequences.last_value + 1
       RETURNING order_date::text, last_value`
    )
    const date = rows[0].order_date.replaceAll('-', '')
    const sequence = String(rows[0].last_value).padStart(5, '0')
    return `MK-${date}-${sequence}`
  }

  /**
   * Create the PARENT customer order of a marketplace checkout (shop_id NULL,
   * is_marketplace TRUE). Seller orders are created separately; every
   * order_items row belongs to exactly one seller order (§7).
   */
  async createParentCheckoutOrder(client, data) {
    const { rows } = await client.query(
      `INSERT INTO orders (
        order_number, customer_id, shop_id, is_marketplace, status, items,
        subtotal, discount_amount, coupon_discount_amount, coupon_absorber,
        loyalty_redeemed_amount, points_redeemed,
        delivery_fee, platform_fee, tax_amount, shipping_charge, total_payable,
        payment_method, payment_status, coupon_code, delivery_address,
        delivery_notes, estimated_delivery, wallet_amount, wallet_debited, client_order_ref,
        payment_plan, advance_amount, amount_paid, amount_due
      ) VALUES (
        $1,$2,NULL,TRUE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
      )
      RETURNING *`,
      [
        data.orderNumber, data.customerId, data.status,
        JSON.stringify(data.items), data.subtotal, data.discountAmount || 0,
        data.couponDiscountAmount || 0, data.couponAbsorber || null,
        data.loyaltyRedeemedAmount || 0, data.pointsRedeemed || 0,
        data.deliveryFee || 0, data.platformFee || 0, data.taxAmount || 0,
        data.shippingCharge || 0, data.totalPayable,
        data.paymentMethod, data.paymentStatus,
        data.couponCode || null, JSON.stringify(data.deliveryAddress),
        data.deliveryNotes || null, data.estimatedDelivery || null,
        data.walletAmount || 0, !!data.walletDebited, data.clientOrderRef || null,
        data.paymentPlan || 'FULL_ONLINE', data.advanceAmount || 0,
        data.amountPaid || 0, data.amountDue || 0,
      ]
    )
    await client.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
       VALUES ($1, NULL, $2, $3, 'Marketplace order placed')`,
      [rows[0].id, data.status, data.customerId]
    ).catch(() => {})
    return rows[0]
  }

  /** Create one seller (vendor) sub-order of a parent marketplace order. */
  async createSellerOrder(client, data) {
    const { rows } = await client.query(
      `INSERT INTO seller_orders (
        order_id, seller_order_number, vendor_id, shop_id, status,
        item_subtotal, seller_discount, platform_discount,
        commission_rate, commission_amount, tax_amount, shipping_charge,
        payable_to_seller, estimated_delivery,
        platform_charge, fee_tax_amount, fee_breakdown, channel
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [
        data.orderId, data.sellerOrderNumber, data.vendorId, data.shopId,
        data.status || 'ORDER_PLACED',
        data.itemSubtotal, data.sellerDiscount || 0, data.platformDiscount || 0,
        data.commissionRate || 0, data.commissionAmount || 0,
        data.taxAmount || 0, data.shippingCharge || 0,
        data.payableToSeller || 0, data.estimatedDelivery || null,
        data.platformCharge || 0, data.feeTaxAmount || 0,
        data.feeBreakdown ? JSON.stringify(data.feeBreakdown) : null,
        data.channel || 'B2C',
      ]
    )
    return rows[0]
  }

  /** Next seller sub-order suffix (S1, S2, …) for a parent order. */
  async nextSellerOrderSuffix(client, orderId) {
    const { rows } = await client.query(
      `SELECT COUNT(*) + 1 AS n FROM seller_orders WHERE order_id = $1`, [orderId]
    )
    return `S${rows[0].n}`
  }

  async findByIdAndUser(orderId, userId) {
    const { rows } = await query(
      `SELECT * FROM orders WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [orderId, userId]
    )
    return rows[0] ? this._formatCheckoutOrder(rows[0]) : null
  }

  /** Every order created from a given checkout attempt's idempotency ref. */
  async findByClientOrderRef(customerId, clientOrderRef) {
    if (!clientOrderRef) return []
    const { rows } = await query(
      `SELECT * FROM orders WHERE customer_id = $1 AND client_order_ref = $2 ORDER BY created_at`,
      [customerId, clientOrderRef]
    )
    return rows.map((row) => this._formatCheckoutOrder(row))
  }

  /**
   * Atomically claim the pending wallet debit for an order — flips
   * `wallet_debited` false→true and returns the amount to actually debit,
   * or `null` if there's nothing pending (already claimed, or wallet was
   * never toggled on for this order). Both `verifyPayment` and the
   * Razorpay webhook can race to confirm the same payment; only whichever
   * one wins this UPDATE actually touches the wallet.
   */
  async claimWalletDebit(orderId) {
    const { rows } = await query(
      `UPDATE orders SET wallet_debited = true, updated_at = NOW()
       WHERE id = $1 AND wallet_debited = false AND wallet_amount > 0
       RETURNING id, customer_id, wallet_amount, order_number`,
      [orderId]
    )
    return rows[0] || null
  }

  /** Most recent order still in progress (not delivered/cancelled/returned). */
  async getActiveOrder(customerId) {
    const { rows } = await query(
      `SELECT * FROM orders
       WHERE customer_id = $1
         AND status NOT IN ('CANCELLED', 'COMPLETED', 'DELIVERED', 'RETURNED')
         AND payment_status != 'FAILED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [customerId]
    )
    return rows[0] ? this._formatCheckoutOrder(rows[0]) : null
  }

  /**
   * The customer's proof-of-delivery OTP for an order whose rider is on the
   * way (accepted / in transit). Only ever surfaced to the order's owner —
   * see OrdersService#getOrderById. Null when no rider holds the order.
   */
  async getActiveDeliveryOtp(orderId) {
    const { rows } = await query(
      `SELECT delivery_otp FROM delivery_assignments
       WHERE order_id = $1
         AND status IN ('ACCEPTED', 'PICKED_UP', 'IN_TRANSIT')
         AND delivery_otp IS NOT NULL
       ORDER BY assigned_at DESC NULLS LAST
       LIMIT 1`,
      [orderId]
    )
    return rows[0]?.delivery_otp || null
  }

  async getOrderItems(orderId) {
    const { rows } = await query(
      `SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at`,
      [orderId]
    )
    return rows
  }

  _formatCheckoutOrder(row) {
    return {
      id: row.id,
      orderNumber: row.order_number,
      customerId: row.customer_id,
      shopId: row.shop_id || null,
      status: row.status,
      items: typeof row.items === 'string' ? JSON.parse(row.items) : row.items,
      subtotal: Number(row.subtotal || 0),
      discountAmount: Number(row.discount_amount || 0),
      deliveryFee: Number(row.delivery_fee || 0),
      platformFee: Number(row.platform_fee || 0),
      taxAmount: Number(row.tax_amount || 0),
      totalAmount: Number(row.total_payable || 0),
      walletAmountUsed: Number(row.wallet_amount || 0),
      walletDebited: !!row.wallet_debited,
      paymentMethod: row.payment_method,
      paymentStatus: row.payment_status,
      paymentPlan: row.payment_plan || 'FULL_ONLINE',
      advanceAmount: Number(row.advance_amount || 0),
      amountPaid: Number(row.amount_paid || 0),
      amountDue: Number(row.amount_due || 0),
      couponCode: row.coupon_code || null,
      clientOrderRef: row.client_order_ref || null,
      deliveryAddress: typeof row.delivery_address === 'string'
        ? JSON.parse(row.delivery_address)
        : row.delivery_address,
      deliveryNotes: row.delivery_notes || null,
      estimatedDelivery: row.estimated_delivery || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
  async createOrder({ order_number, quote_id, customer_id, warehouse_id = null, status = 'ORDER_PLACED', subtotal, discount_amount, loyalty_redeemed_amount, tax_amount, total_payable }) {
    const { rows } = await query(
      `INSERT INTO orders (order_number, quote_id, customer_id, warehouse_id, status, subtotal, discount_amount, loyalty_redeemed_amount, tax_amount, total_payable)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [order_number, quote_id, customer_id, warehouse_id, status, subtotal, discount_amount, loyalty_redeemed_amount, tax_amount, total_payable]
    )
    return rows[0]
  }

  async addOrderItem(orderId, itemData) {
    const { product_id, product_name, quantity, unit_price, subtotal, product_snapshot = {} } = itemData
    const { rows } = await query(
      `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, subtotal, product_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [orderId, product_id, product_name, quantity, unit_price, subtotal, JSON.stringify(product_snapshot)]
    )
    return rows[0]
  }

  async findOrderById(orderId) {
    const { rows } = await query(`SELECT * FROM orders WHERE id = $1 LIMIT 1`, [orderId])
    if (!rows[0]) return null

    const order = rows[0]
    const itemsRes = await query(`SELECT * FROM order_items WHERE order_id = $1 ORDER BY created_at ASC`, [orderId])
    const tasksRes = await query(`SELECT * FROM fulfilment_tasks WHERE order_id = $1 ORDER BY created_at ASC`, [orderId])
    const historyRes = await query(`SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY changed_at ASC`, [orderId])

    return {
      ...order,
      // `orders.total_payable`/`orders.wallet_amount` are the real column
      // names (migrations 106/127) — mirrored here under the camelCase keys
      // every client (mobile `OrderModel`, `invoiceGenerator.js`) actually
      // reads, without dropping the raw snake_case columns other callers of
      // this method (transitionOrderStatus, createFulfilmentTask, getInvoice's
      // customer_id ownership check) still rely on.
      totalAmount: Number(order.total_payable || 0),
      walletAmountUsed: Number(order.wallet_amount || 0),
      items: itemsRes.rows.map((row) => this._formatOrderItem(row)),
      fulfilment_tasks: tasksRes.rows,
      status_history: historyRes.rows,
    }
  }

  /**
   * `order_items` rows carry the real relational columns (`product_name`,
   * `unit_price`, `subtotal`) — none of which are named `name`/`price`/
   * `total`/`unit`/`thumbnailUrl`, the shape every client that renders an
   * order (mobile's `OrderItemModel`, `invoiceGenerator.js`) expects. The
   * checkout-time item object (mobile `OrderItemModel`'s own camelCase
   * shape) is preserved verbatim in `product_snapshot` (JSONB) on each row
   * — prefer it, falling back to the relational columns for any row placed
   * before `product_snapshot` was populated.
   */
  _formatOrderItem(row) {
    const snapshot = (typeof row.product_snapshot === 'string'
      ? JSON.parse(row.product_snapshot || '{}')
      : row.product_snapshot) || {}
    return {
      id: row.id,
      productId: row.product_id,
      shopProductId: row.shop_product_id || snapshot.shopProductId || null,
      name: snapshot.name || row.product_name || 'Item',
      price: Number(snapshot.price ?? row.unit_price ?? 0),
      quantity: Number(row.quantity ?? snapshot.quantity ?? 0),
      unit: snapshot.unit || null,
      brand: snapshot.brand || null,
      // Only present on orders placed after this field started being
      // captured at checkout (see orders.service.js#placeOrder) — an older
      // row's snapshot simply won't have it, and this stays `null`/`0`
      // rather than inventing a discount that was never actually recorded.
      originalPrice: snapshot.originalPrice != null ? Number(snapshot.originalPrice) : null,
      discountPercent: snapshot.discountPercent ? Number(snapshot.discountPercent) : 0,
      total: Number(snapshot.total ?? row.subtotal ?? 0),
      thumbnailUrl: snapshot.thumbnailUrl || null,
    }
  }

  async findOrderByNumber(orderNumber) {
    const { rows } = await query(`SELECT id FROM orders WHERE order_number = $1 LIMIT 1`, [orderNumber])
    if (!rows[0]) return null
    return this.findOrderById(rows[0].id)
  }

  async findById(orderId) {
    return this.findOrderById(orderId)
  }

  /**
   * Row-locked read for the payment-finalization transaction
   * (`PaymentsService#completeVerifiedPayment`) — it needs to know the
   * order's CURRENT status, inside the same transaction as the payment
   * update, to decide whether the order is still confirmable (`PENDING`)
   * or has already moved on (e.g. cancelled — see `needs_manual_review`).
   */
  async findByIdForUpdate(client, orderId) {
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId]
    )
    return rows[0] || null
  }

  /** `client` runs this inside the caller's own transaction; omit it to use the pool directly. */
  async updateStatus(orderId, status, options = {}, client = null) {
    const runner = client || { query: (text, params) => query(text, params) }
    const setClauses = []
    const params = []

    if (status !== undefined) {
      setClauses.push(`status = $${params.length + 1}`)
      params.push(status)
    }

    if (options.paymentStatus !== undefined) {
      setClauses.push(`payment_status = $${params.length + 1}`)
      params.push(options.paymentStatus)
    }

    if (options.onlinePaid !== undefined) {
      // Money just captured online (full bill or the partial-payment advance).
      // total_payable is already net of the wallet slice.
      setClauses.push(`amount_paid = COALESCE(wallet_amount, 0) + $${params.length + 1}`)
      setClauses.push(`amount_due = GREATEST(0, total_payable - $${params.length + 1})`)
      params.push(options.onlinePaid)
    }

    if (options.paymentExpiresAt !== undefined) {
      setClauses.push(`payment_expires_at = $${params.length + 1}`)
      params.push(options.paymentExpiresAt)
    }

    if (setClauses.length === 0) {
      return this.findOrderById(orderId)
    }

    params.push(orderId)
    const { rows } = await runner.query(
      `UPDATE orders SET ${setClauses.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    )
    return rows[0]
  }

  async updateOrderStatus(orderId, status) {
    return this.updateStatus(orderId, status)
  }

  // `order_status_history` was first created by migration 015 with columns
  // `changed_by`/`note`/`changed_at` (every other module — admin/orders,
  // delivery, shop-orders, invoiceGenerator.js — inserts/reads those). A
  // later migration (106) tried to redefine the table with `actor_id`/
  // `notes`/`created_at`, but its `CREATE TABLE IF NOT EXISTS` was a no-op
  // against the already-existing 015 table, so those columns never actually
  // existed in any deployed database — this INSERT failed with "column
  // actor_id does not exist" on every call, which is what made every order
  // placement 500 even after the order-number bug (§7.2) was fixed.
  // `client` lets a caller inside its own BEGIN/COMMIT (placeOrder) run this
  // on that same transaction connection — required, since the order row it
  // references via `order_id` isn't visible to a different pool connection
  // until that transaction commits.
  async logStatusTransition(orderId, fromStatus, toStatus, actorId = null, notes = null, client = null) {
    const runner = client || { query: (text, params) => query(text, params) }
    const { rows } = await runner.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [orderId, fromStatus, toStatus, actorId, notes]
    )
    return rows[0]
  }

  async createFulfilmentTask(orderId, taskType, assignedTo = null, notes = null) {
    const { rows } = await query(
      `INSERT INTO fulfilment_tasks (order_id, task_type, assigned_to, status, notes)
       VALUES ($1, $2, $3, 'PENDING', $4)
       RETURNING *`,
      [orderId, taskType, assignedTo, notes]
    )
    return rows[0]
  }

  async updateFulfilmentTaskStatus(taskId, status, notes = null) {
    const { rows } = await query(
      `UPDATE fulfilment_tasks SET status = $2, notes = COALESCE($3, notes) WHERE id = $1 RETURNING *`,
      [taskId, status, notes]
    )
    return rows[0]
  }

  async logAudit(orderId, actorId = null, action = '', payload = {}) {
    const { rows } = await query(
      `INSERT INTO order_audit_logs (order_id, actor_id, action, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [orderId, actorId, action, JSON.stringify(payload)]
    )
    return rows[0]
  }

  async listOrders(customerId = null, warehouseId = null, status = null) {
    const conditions = ['1=1']
    const params = []
    let idx = 1

    if (customerId) {
      conditions.push(`customer_id = $${idx}`)
      params.push(customerId)
      idx++
    }

    if (warehouseId) {
      conditions.push(`warehouse_id = $${idx}`)
      params.push(warehouseId)
      idx++
    }

    if (status) {
      conditions.push(`status = $${idx}`)
      params.push(status)
      idx++
    }

    const { rows } = await query(
      `SELECT * FROM orders WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
      params
    )
    if (rows.length === 0) return []

    // Batch-fetch every row's items in one query (never N+1) and group by
    // order — the "My Orders" list card (`order_card.dart`) reads
    // `order.items.first.name/thumbnailUrl` and `order.total`, so this
    // needs the same camelCase formatting `findOrderById` uses, not the
    // raw `orders`/`order_items` columns.
    const orderIds = rows.map((r) => r.id)
    const { rows: itemRows } = await query(
      `SELECT * FROM order_items WHERE order_id = ANY($1) ORDER BY created_at ASC`,
      [orderIds]
    )
    const itemsByOrder = new Map()
    for (const row of itemRows) {
      const list = itemsByOrder.get(row.order_id) || []
      list.push(this._formatOrderItem(row))
      itemsByOrder.set(row.order_id, list)
    }

    return rows.map((order) => ({
      ...order,
      totalAmount: Number(order.total_payable || 0),
      walletAmountUsed: Number(order.wallet_amount || 0),
      items: itemsByOrder.get(order.id) || [],
    }))
  }
}
