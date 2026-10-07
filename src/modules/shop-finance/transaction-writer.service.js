import { logger } from '../../config/logger.js'
import { getClient } from '../../config/database.js'
import { emitInTx } from '../../utils/audit-log.js'
import { ShopTransactionsRepository } from '../shop-transactions/shop-transactions.repository.js'
import {
  LedgerWriteService,
  ShopTransactionsService,
} from '../shop-transactions/shop-transactions.service.js'

/**
 * Transaction Writer Service — V2 transaction insert helpers (tasks 8.2–8.7).
 *
 * Provides atomic insert methods for:
 *   - ORDER_REVENUE (CREDIT) + PLATFORM_COMMISSION (DEBIT) + optional
 *     DELIVERY_FEE (CREDIT) + RIDER_COST (DEBIT) — task 8.2
 *   - COUPON_DISCOUNT (DEBIT) — task 8.3
 *   - TAX (DEBIT) — task 8.4
 *   - REFUND (DEBIT) — task 8.5
 *   - PAYOUT (DEBIT) — task 8.6
 *
 * Task 8.7: Every insert emits `transaction_posted` audit via the
 * LedgerWriteService.append() method which already calls emitInTx.
 *
 * The V2 columns (direction, status, metadata, rider_id, order_id) are
 * passed through to the repository's insertEntry method.
 */
export class TransactionWriterService {
  /**
   * @param {object} [deps]
   * @param {LedgerWriteService} [deps.ledgerWriteService]
   */
  constructor(deps = {}) {
    if (deps.ledgerWriteService) {
      this.ledger = deps.ledgerWriteService
    } else {
      const txRepo = new ShopTransactionsRepository()
      const readService = new ShopTransactionsService(txRepo)
      this.ledger = new LedgerWriteService(txRepo, { readService })
    }
  }

  /**
   * Task 8.2: Insert per-order settlement transactions in one transaction.
   * Called by the settlement worker for each delivered order.
   *
   * Inserts:
   *   - ORDER_REVENUE (CREDIT) — the order subtotal
   *   - PLATFORM_COMMISSION (DEBIT) — commission on the order
   *   - DELIVERY_FEE (CREDIT) — if delivery_fee > 0 (shop receives fee)
   *   - RIDER_COST (DEBIT) — if rider_cost > 0 (shop pays rider)
   *
   * @param {import('pg').PoolClient} client - caller-owned transaction
   * @param {object} params
   * @param {string} params.shopId
   * @param {string} params.orderId
   * @param {number} params.subtotal - order subtotal (ORDER_REVENUE amount)
   * @param {number} params.commissionAmount - pre-computed commission
   * @param {number} [params.deliveryFee=0] - delivery fee collected
   * @param {number} [params.riderCost=0] - rider cost to deduct
   * @param {string|null} [params.riderId] - rider UUID
   * @param {string|null} [params.createdBy] - actor UUID
   * @returns {Promise<{revenue: object, commission: object|null, deliveryFee: object|null, riderCost: object|null}>}
   */
  async recordSettlementEntries(client, params) {
    const {
      shopId, orderId, subtotal, commissionAmount,
      deliveryFee = 0, riderCost = 0, riderId = null, createdBy = null,
    } = params

    // ORDER_REVENUE (CREDIT)
    const revenue = await this.ledger.append(client, {
      shopId,
      type: 'ORDER_REVENUE',
      amount: subtotal,
      referenceType: 'ORDER',
      referenceId: orderId,
      description: `Order revenue`,
      createdBy,
    })

    // PLATFORM_COMMISSION (DEBIT)
    let commission = null
    if (commissionAmount > 0) {
      commission = await this.ledger.append(client, {
        shopId,
        type: 'PLATFORM_COMMISSION',
        amount: commissionAmount,
        referenceType: 'ORDER',
        referenceId: orderId,
        description: `Platform commission`,
        createdBy,
      })
    }

    // DELIVERY_FEE (CREDIT) — shop receives the delivery fee
    let deliveryFeeEntry = null
    if (deliveryFee > 0) {
      deliveryFeeEntry = await this.ledger.append(client, {
        shopId,
        type: 'DELIVERY_FEE',
        amount: deliveryFee,
        referenceType: 'ORDER',
        referenceId: orderId,
        description: `Delivery fee collected`,
        createdBy,
      })
    }

    // RIDER_COST (DEBIT) — shop pays the rider
    let riderCostEntry = null
    if (riderCost > 0) {
      riderCostEntry = await this.ledger.append(client, {
        shopId,
        type: 'RIDER_COST',
        amount: riderCost,
        referenceType: 'ORDER',
        referenceId: orderId,
        description: `Rider delivery cost`,
        createdBy,
      })
    }

    return { revenue, commission, deliveryFee: deliveryFeeEntry, riderCost: riderCostEntry }
  }

  /**
   * Task 8.3: Insert COUPON_DISCOUNT (DEBIT) per shop order group at
   * order-creation time.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} params
   * @param {string} params.shopId
   * @param {string} params.orderId
   * @param {number} params.discountAmount
   * @param {string} params.couponCode
   * @param {string} params.couponType - e.g. 'PERCENTAGE', 'FLAT'
   * @param {string} params.absorber - 'PLATFORM' | 'SHOP' | 'SPLIT'
   * @param {string|null} [params.createdBy]
   * @returns {Promise<object>} inserted row
   */
  async recordCouponDiscount(client, params) {
    const { shopId, orderId, discountAmount, couponCode, couponType, absorber, createdBy = null } = params

    if (discountAmount <= 0) return null

    const entry = await this.ledger.append(client, {
      shopId,
      type: 'COUPON_DISCOUNT',
      amount: discountAmount,
      referenceType: 'COUPON',
      referenceId: orderId,
      description: `Coupon ${couponCode} discount`,
      createdBy,
    })

    // Update metadata on the inserted row with coupon details
    await client.query(
      `UPDATE shop_transactions
          SET metadata = $2::jsonb,
              order_id = $3
        WHERE id = $1`,
      [
        entry.id,
        JSON.stringify({ coupon_code: couponCode, coupon_type: couponType, absorber }),
        orderId,
      ]
    )

    return entry
  }

  /**
   * Task 8.4: Insert TAX (DEBIT) row per tax line item at order creation.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} params
   * @param {string} params.shopId
   * @param {string} params.orderId
   * @param {number} params.taxAmount
   * @param {string} params.taxCode - e.g. 'GST', 'CGST', 'SGST'
   * @param {number} params.taxRate - percentage rate
   * @param {string|null} [params.createdBy]
   * @returns {Promise<object>} inserted row
   */
  async recordTax(client, params) {
    const { shopId, orderId, taxAmount, taxCode, taxRate, createdBy = null } = params

    if (taxAmount <= 0) return null

    const entry = await this.ledger.append(client, {
      shopId,
      type: 'TAX',
      amount: taxAmount,
      referenceType: 'TAX',
      referenceId: orderId,
      description: `Tax ${taxCode} @ ${taxRate}%`,
      createdBy,
    })

    // Update metadata with tax details
    await client.query(
      `UPDATE shop_transactions
          SET metadata = $2::jsonb,
              order_id = $3
        WHERE id = $1`,
      [
        entry.id,
        JSON.stringify({ tax_code: taxCode, tax_rate: taxRate }),
        orderId,
      ]
    )

    return entry
  }

  /**
   * Task 8.5: Insert REFUND (DEBIT) on refund processing.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} params
   * @param {string} params.shopId
   * @param {string} params.orderId
   * @param {number} params.refundAmount
   * @param {string} params.reason
   * @param {string|null} [params.operator] - admin/operator who initiated
   * @param {string|null} [params.createdBy]
   * @returns {Promise<object>} inserted row
   */
  async recordRefund(client, params) {
    const { shopId, orderId, refundAmount, reason, operator = null, createdBy = null } = params

    if (refundAmount <= 0) return null

    const entry = await this.ledger.append(client, {
      shopId,
      type: 'REFUND',
      amount: refundAmount,
      referenceType: 'REFUND',
      referenceId: orderId,
      description: `Refund: ${reason}`,
      createdBy: createdBy || operator,
    })

    // Update metadata with refund details
    await client.query(
      `UPDATE shop_transactions
          SET metadata = $2::jsonb,
              order_id = $3
        WHERE id = $1`,
      [
        entry.id,
        JSON.stringify({ reason, operator }),
        orderId,
      ]
    )

    return entry
  }

  /**
   * Task 8.6: Insert PAYOUT (DEBIT) referencing metadata.payout_id on
   * payout processing. Preserves legacy PAYOUT_CREDIT as read-only.
   *
   * @param {import('pg').PoolClient} client
   * @param {object} params
   * @param {string} params.shopId
   * @param {string} params.payoutId - the shop_financials.id being paid out
   * @param {number} params.payoutAmount
   * @param {string|null} [params.description]
   * @param {string|null} [params.createdBy]
   * @returns {Promise<object>} inserted row
   */
  async recordPayout(client, params) {
    const { shopId, payoutId, payoutAmount, description = null, createdBy = null } = params

    if (payoutAmount <= 0) return null

    const entry = await this.ledger.append(client, {
      shopId,
      type: 'PAYOUT',
      amount: payoutAmount,
      referenceType: 'PAYOUT',
      referenceId: payoutId,
      description: description || `Payout disbursement`,
      createdBy,
    })

    // Update metadata with payout_id reference
    await client.query(
      `UPDATE shop_transactions
          SET metadata = $2::jsonb
        WHERE id = $1`,
      [
        entry.id,
        JSON.stringify({ payout_id: payoutId }),
      ]
    )

    return entry
  }
}
