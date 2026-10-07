/**
 * Authoritative delivery lifecycle status sets (blueprint Big Phase 7).
 *
 * Every module that reasons about "which assignments keep a rider
 * busy" or "which order states can still be claimed" MUST import these
 * constants instead of re-declaring inline arrays. Divergence here is
 * how a rider ends up with two active orders: e.g. the dispatch
 * candidate query historically forgot `PICKED_UP` while every admin
 * module treated it as busy.
 *
 * The sets mirror the DB CHECK constraint on
 * `delivery_assignments.status`
 * (migrations/013: ASSIGNED, ACCEPTED, PICKED_UP, IN_TRANSIT,
 * DELIVERED, CANCELLED) exactly:
 *
 * - OPEN: non-terminal from the *offer* perspective — an open row
 *   either waits for a decision (ASSIGNED) or occupies the rider
 *   (claimed). Used for "does this rider have any open row for this
 *   order" checks and requeue decisions.
 * - CLAIMED: the rider has taken ownership — dispatch must never
 *   offer them another order, and admin shows them busy.
 * - ASSIGNABLE: order states in which the order may still be claimed
 *   by a rider (pre-dispatch kitchen pipeline).
 */

export const ASSIGNABLE_ORDER_STATUSES = ['CONFIRMED', 'PREPARING', 'PACKED']

export const CLAIMED_ASSIGNMENT_STATUSES = ['ACCEPTED', 'PICKED_UP', 'IN_TRANSIT']

export const OPEN_ASSIGNMENT_STATUSES = ['ASSIGNED', ...CLAIMED_ASSIGNMENT_STATUSES]

/** Human-readable summary used in logs and conflict copy. */
export const CLAIMED_STATUSES_TEXT = CLAIMED_ASSIGNMENT_STATUSES.join(', ')

/**
 * Renders a trusted internal constant list as a SQL `IN (...)` list.
 * Values are compile-time constants from this module — never user
 * input — so naive quoting is safe by construction.
 */
export function sqlInList(values) {
  return values.map((value) => `'${value}'`).join(', ')
}
