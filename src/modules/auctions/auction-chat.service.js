/**
 * Auction chat — the selling vendor and the winning buyer talk about the lot (pickup, delivery, payment).
 *
 * Only those two parties can read or write; admin-owned auctions have no seller to talk to. The thread opens when
 * the auction has a winner (awaiting payment or sold) and is keyed by the winner, so a re-offer to the next bidder
 * starts a clean conversation instead of leaking the previous one.
 *
 * @module modules/auctions/auction-chat.service
 */
import { query } from '../../config/database.js'
import { pingVendors } from '../../utils/vendor-live.js'
import { AuctionError, notifyUser } from './auction.shared.js'

const OPEN = ['AWAITING_PAYMENT', 'SOLD']

/** Who is this actor on this auction? Throws unless they are the seller or the current winner. */
async function party(actor, auctionId) {
  const { rows } = await query('SELECT id, title, status, vendor_id, winner_id, auction_number FROM auctions WHERE id = $1', [auctionId])
  const a = rows[0]
  if (!a) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
  let role = null
  if (actor.kind === 'VENDOR' && actor.vendorId && a.vendor_id === actor.vendorId) role = 'SELLER'
  else if (actor.kind === 'BUYER' && a.winner_id && a.winner_id === actor.userId) role = 'BUYER'
  if (!role) throw new AuctionError('NOT_FOUND', 'Auction not found', 404)
  if (!a.winner_id || !OPEN.includes(a.status)) throw new AuctionError('CHAT_CLOSED', 'Chat opens once the auction has a winner', 409)
  return { a, role }
}

const view = (m, role) => ({ id: String(m.id), mine: m.sender_role === role, from: m.sender_role, body: m.body, at: m.created_at.toISOString(), read: !!m.read_at })

export async function listChat(actor, auctionId) {
  const { a, role } = await party(actor, auctionId)
  const other = role === 'BUYER' ? 'SELLER' : 'BUYER'
  const { rows } = await query('SELECT * FROM auction_messages WHERE auction_id = $1 AND buyer_id = $2 ORDER BY id DESC LIMIT 200', [a.id, a.winner_id])
  await query(`UPDATE auction_messages SET read_at = NOW() WHERE auction_id = $1 AND buyer_id = $2 AND sender_role = $3 AND read_at IS NULL`, [a.id, a.winner_id, other])
  return { auctionId: a.id, title: a.title, status: a.status, role, messages: rows.reverse().map((m) => view(m, role)) }
}

export async function sendChat(actor, auctionId, input = {}) {
  const { a, role } = await party(actor, auctionId)
  const body = String(input.body ?? '').trim().slice(0, 1000)
  if (!body) throw new AuctionError('VALIDATION', 'Type a message', 422)
  const { rows: c } = await query('SELECT COUNT(*)::int AS n FROM auction_messages WHERE auction_id = $1 AND buyer_id = $2', [a.id, a.winner_id])
  if (c[0].n >= 500) throw new AuctionError('RATE_LIMITED', 'This chat is full', 429)
  const { rows } = await query('INSERT INTO auction_messages (auction_id, buyer_id, sender_role, sender_id, body) VALUES ($1,$2,$3,$4,$5) RETURNING *', [a.id, a.winner_id, role, actor.userId, body])
  if (role === 'SELLER') notifyUser(a.winner_id, { title: 'Message from the seller', body: body.slice(0, 80), data: { type: 'AUCTION_CHAT', auctionId: a.id } })
  else if (a.vendor_id) pingVendors([a.vendor_id], { kind: 'chat', title: 'New message from the buyer', body: body.slice(0, 80), data: { auctionId: a.id }, push: true })
  return view(rows[0], role)
}

/** Unread count for the badge, 0 when the viewer is not a party or there is no open thread. */
export async function unreadChat(actor, auctionId) {
  try {
    const { a, role } = await party(actor, auctionId)
    const { rows } = await query(`SELECT COUNT(*)::int AS n FROM auction_messages WHERE auction_id = $1 AND buyer_id = $2 AND sender_role = $3 AND read_at IS NULL`,
      [a.id, a.winner_id, role === 'BUYER' ? 'SELLER' : 'BUYER'])
    return rows[0].n
  } catch { return 0 }
}
