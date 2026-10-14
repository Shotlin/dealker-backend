/**
 * Wholesale price mode is for verified vendors only. The cart and checkout accept `priceMode: 'wholesale'`
 * from the client, so without this guard any customer could buy at the B2B wholesale price
 * (found in live QA 2026-10-14: a customer ordered ₹600 stock for ₹3,005 instead of ₹5,005).
 */
import { findActiveVendorMemberships, isPlatformUser } from './vendor-scope.js'

export async function wholesaleGuard(request, reply) {
  const wanted = request.body?.priceMode === 'wholesale' || request.query?.priceMode === 'wholesale'
  if (!wanted) return
  const user = request.user
  if (isPlatformUser(user)) return
  if (user?.vendorId) return
  const memberships = user?.id ? await findActiveVendorMemberships(user.id) : []
  if (memberships.length) return
  return reply.code(403).send({ success: false, code: 'WHOLESALE_NOT_ALLOWED', message: 'Wholesale prices are only available to verified vendors' })
}
