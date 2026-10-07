/**
 * Winner checkout — turns an AWAITING_PAYMENT auction into a real marketplace
 * order (parent order + one seller order), so settlements, shipping, returns
 * and loyalty all work exactly as for a normal purchase.
 *
 * Pricing:  subtotal (item) = winning bid
 *           discount        = the winner's registration fee (already paid)
 *           payable now     = winning bid − fee
 * The vendor is settled on the FULL winning bid (minus commission); the
 * discount is funded by the winner's own escrowed fee, so it is net-zero for
 * the platform. No platform_discount is booked on the seller order — that
 * would make the settlement ledger reimburse the vendor twice.
 *
 * Stock was already taken off sale when the auction was scheduled
 * (reserveStock), so checkout does not deduct it again.
 *
 * @module modules/auctions/auction-checkout.service
 */

import { OrdersRepository } from '../orders/orders.repository.js'
import { WalletRepository } from '../wallet/wallet.repository.js'
import { logger } from '../../config/logger.js'
import { toPaise, fromPaise } from './auction-engine.js'
import { AuctionError, logEvent } from './auction.shared.js'
import { lockAuction, onWinnerPaid, withTx } from './auction-settlement.service.js'

const ordersRepo = new OrdersRepository()
const walletRepo = new WalletRepository()

export async function checkout(userId, auctionId, { addressId, paymentMethod = 'WALLET', notes = null }) {
  if (!['WALLET', 'ONLINE'].includes(paymentMethod)) {
    throw new AuctionError('INVALID_PAYMENT_METHOD', 'Pay from your wallet or online', 400)
  }
  if (!addressId) throw new AuctionError('ADDRESS_REQUIRED', 'Choose a delivery address', 400)

  return withTx(async (client, post) => {
    const a = await lockAuction(client, auctionId)
    if (!a) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
    if (a.winner_id !== userId) throw new AuctionError('NOT_WINNER', 'Only the winning bidder can check out', 403)
    if (a.status !== 'AWAITING_PAYMENT') throw new AuctionError('INVALID_STATE', `This auction is ${a.status}`, 409)
    if (a.order_id) throw new AuctionError('ORDER_EXISTS', 'An order already exists for this auction — complete its payment', 409, { order_id: a.order_id })
    const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now
    if (new Date(a.payment_deadline) <= now) throw new AuctionError('DEADLINE_PASSED', 'The payment window for this auction has closed', 409)

    const { rows: addr } = await client.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [addressId, userId])
    if (!addr[0]) throw new AuctionError('ADDRESS_NOT_FOUND', 'Delivery address not found', 404)

    const { rows: prod } = await client.query(
      'SELECT id, name, thumbnail_url, brand, price FROM products WHERE id = $1', [a.product_id]
    )
    const p = prod[0]
    const { rows: shopRows } = await client.query('SELECT vendor_id, commission_rate FROM shops WHERE id = $1', [a.shop_id])
    const shop = shopRows[0] || {}

    const subtotal = Number(a.winning_bid)
    const feeCredit = Number(a.fee_credit)
    const amountDue = Number(a.amount_due)
    const payWithWallet = paymentMethod === 'WALLET'

    // wallet tender (atomic: same guarded UPDATE the normal checkout uses)
    let wallet = null
    if (payWithWallet) {
      await client.query('INSERT INTO wallets (user_id, balance) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING', [userId])
      wallet = await walletRepo.getForUpdate(client, userId)
      if (toPaise(wallet.balance) < toPaise(amountDue)) {
        throw new AuctionError('INSUFFICIENT_WALLET', 'Not enough wallet balance — add money or pay online', 402, {
          required: amountDue, balance: Number(wallet.balance), shortfall: fromPaise(toPaise(amountDue) - toPaise(wallet.balance)),
        })
      }
    }

    const item = {
      productId: a.product_id,
      shopProductId: a.shop_product_id,
      name: a.title || p?.name,
      price: subtotal,
      quantity: 1,
      total: subtotal,
      thumbnailUrl: a.image_url || p?.thumbnail_url || null,
      pricingMode: 'retail',
      brand: p?.brand || null,
      originalPrice: p?.price != null && Number(p.price) > subtotal ? Number(p.price) : null,
      discountPercent: 0,
      auctionId: a.id,
      isAuctionItem: true,
    }

    const orderNumber = await ordersRepo.generateMarketplaceOrderNumber(client)
    const parent = await ordersRepo.createParentCheckoutOrder(client, {
      orderNumber,
      customerId: userId,
      status: 'ORDER_PLACED',
      items: [item],
      subtotal,
      discountAmount: feeCredit,
      couponDiscountAmount: 0,
      deliveryFee: 0,
      platformFee: 0,
      totalPayable: payWithWallet ? 0 : amountDue,
      paymentMethod: 'ONLINE',
      paymentStatus: payWithWallet ? 'PAID' : 'PENDING',
      deliveryAddress: addr[0],
      deliveryNotes: notes,
      walletAmount: payWithWallet ? amountDue : 0,
      walletDebited: payWithWallet,
    })
    await client.query('UPDATE orders SET auction_id = $2 WHERE id = $1', [parent.id, a.id])

    if (payWithWallet && amountDue > 0) {
      await walletRepo.debit(
        client, wallet.id, amountDue, `Auction ${a.auction_number}: payment for order ${orderNumber}`, parent.id,
        { subType: 'ORDER', orderId: parent.id }
      )
    }

    const commissionRate = Number(shop.commission_rate || 0)
    const commissionAmount = Number(((subtotal * commissionRate) / 100).toFixed(2))
    const suffix = await ordersRepo.nextSellerOrderSuffix(client, parent.id)
    const sellerOrder = await ordersRepo.createSellerOrder(client, {
      orderId: parent.id,
      sellerOrderNumber: `${orderNumber}-${suffix}`,
      vendorId: shop.vendor_id || a.vendor_id || null,
      shopId: a.shop_id,
      status: 'ORDER_PLACED',
      itemSubtotal: subtotal,
      sellerDiscount: 0,
      platformDiscount: 0,
      commissionRate,
      commissionAmount,
      shippingCharge: 0,
      payableToSeller: Number((subtotal - commissionAmount).toFixed(2)),
    })
    await ordersRepo.createCheckoutOrder(client, {
      itemsOnly: true,
      parentOrderId: parent.id,
      shopId: a.shop_id,
      items: [item],
      sellerOrderId: sellerOrder.id,
    })

    await client.query('UPDATE auctions SET order_id = $2, updated_at = NOW() WHERE id = $1', [a.id, parent.id])
    a.order_id = parent.id
    await logEvent(client, a.id, 'CHECKOUT', { userId, kind: 'CUSTOMER' }, {
      order_id: parent.id, method: paymentMethod, amount_due: amountDue,
    })

    if (payWithWallet) await onWinnerPaid(client, a, post)
    logger.info({ auctionId: a.id, orderId: parent.id, paymentMethod }, 'Auction checkout completed')

    return {
      order_id: parent.id,
      order_number: orderNumber,
      subtotal,
      fee_credit: feeCredit,
      amount_due: amountDue,
      paid: payWithWallet,
      // ONLINE: the app now starts the normal Razorpay flow for this order id
      payment_required: !payWithWallet,
      auction_status: a.status,
    }
  })
}
