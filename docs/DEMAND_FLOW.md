# Vendor demand flow

Vendors (and the admin on their behalf) post **buying requirements**; verified sellers answer with **offers**; the buyer picks one or several sellers, pays into **escrow**, and the sellers fulfil by courier or buyer pickup. Implemented in `src/modules/b2b` (tables from migration 168, demand additions in `207_demand_flow.sql`).

```
requirement OPEN ──offers──▶ award (split quantity) ──▶ order PENDING_PAYMENT ──pay──▶ PAID (escrow)
   ▲   (matching sellers alerted)                                                        │ pack (optional)
   │                                                                                     ▼
   └── seller cancels a paid order (buyer refunded)                    DISPATCHED (courier + AWB | pickup slot)
                                                                                         │ seller marks delivered (courier only)
                                                                                         ▼
                         buyer confirms receipt ── all good ──▶ COMPLETED (seller paid − commission)
                                                └─ short / wrong ─▶ DISPUTED ──admin──▶ release | partial | refund
```

## What a requirement carries
`product_name, brand, storage, quantity_needed, target_price (+ target_price_max), condition_pref (ANY|NEW|USED_OR_REFURBISHED), min_battery_health, display_pref (ANY|ORIGINAL|GRADE_AB), fulfilment_pref (ANY|PICKUP|DELIVERY), is_urgent, delivery_city/pincode, required_by, response_deadline, description`.
`model_key` (derived: lower-case name without storage and brand words) powers matching and the catalogue thumbnail. Tags are computed: **URGENT** (flag, or needed within 3 days) and **BULK** (20+ units).

## Matching (`demand.match.js`)
A listing matches when it is the same model **and variant** ("iPhone 13" never matches "13 Pro"/"mini"), the condition is acceptable, and storage / battery do not contradict:
`EXACT` → counts as stock the vendor can promise; `CLOSE` (other storage, battery below the ask) → shown as "similar stock"; otherwise no match. Only the vendor's **approved, active, in-stock** listings are considered.
On create, every eligible vendor gets an in-app row; vendors with an EXACT match get *"Match found: you have N × …"* and a push; others get the generic alert (push only when urgent).

## Money (vendor "Dealker wallet" = settlement ledger)
- Vendors can pay **only** with `method: "WALLET"`. The buyer's ledger is debited the order total (`reason_code B2B_PURCHASE`) under the vendor's settlement advisory lock; short balance → `402 INSUFFICIENT_WALLET {required, balance, shortfall}`; an active settlement hold → `409 WALLET_HOLD`. A repeat call finds nothing to pay.
- Release on a clean receipt posts `GROSS_SALES` and `COMMISSION` to the seller (commission = per-vendor override or the default `%`).
- Refunds (`B2B_REFUND`, only when the payment was a wallet payment): seller/admin cancel of a PAID/PACKED order (full), dispute `REFUND` (full) and `PARTIAL` (the units not released).
- Admin can still **record a payment taken outside the app** (`method` other than WALLET): escrow is recorded but no ledger moves, and such payments are never refunded automatically.

## Vendor API (`/api/v1/vendor/b2b`, vendor JWT)
| | |
|---|---|
| `GET /demand/summary` | counts for the hub: open, new, matched, urgent, offers {active,pending,closed,accepted}, mine, orders {to_pay,to_receive,to_dispatch,…} |
| `GET /requirements?scope=open\|new\|matched\|mine\|quoted&tab=active\|pending\|closed&search=` | rows carry `tags`, `thumbnail_url`, `viewed`, `my_match`, `my_quote`, `offer_state`, `my_orders`. Offers are sealed: other vendors never see counts or prices |
| `GET /requirements/:id` | detail; opening it records a view. Buyer sees all quotes (`offer_state`, `seller_city`, `seller_completed_orders`) and marks them viewed |
| `GET /requirements/:id/match` | my matching listings, `canSupply`, suggested offer, `commissionPercent`, my current offer |
| `POST /requirements/:id/dismiss` | "Not interested" — hides it for this vendor |
| `POST /requirements` · `POST /requirements/:id/cancel` | post / cancel (new fields: `storage, targetPriceMax, minBatteryHealth, displayPref, fulfilmentPref, isUrgent`) |
| `POST /requirements/:id/quote` · `POST /quotes/:id/withdraw` | send / update / withdraw an offer (`listingId` optional, must be the vendor's own) |
| `POST /requirements/:id/award` · `POST /requirements/:id/pay` | buyer picks sellers + quantities; pays (WALLET) |
| `GET /wallet` | `{balance, onHold}` — the same ledger sum `pay` checks |
| `GET /orders?role=buying\|selling&bucket=active\|done` · `GET /orders/:id` | list / tracking (counterparty phone + address only after payment) |
| `POST /orders/:id/status` | `PACKED`, `DISPATCHED` (`fulfilmentType: DELIVERY` + `courierName` + `awb`, or `PICKUP` + `pickupAt`), `DELIVERED` |
| `POST /orders/:id/cancel` | seller cancels a PAID/PACKED order with a reason → buyer refunded, units reopen the requirement (deadline extended to ≥ 48 h) |
| `POST /orders/:id/receive` | buyer confirms quantity / reports a problem (→ dispute) |

Admin (`/api/v1/admin/b2b`): everything above on behalf of vendors, plus `GET /insights?days=` (funnel, top models, unanswered requests, reach, time to first offer), `GET /orders/:id`, `POST /orders/:id/cancel`, `POST /orders/:id/resolve`.

## Known limits
Offers do not reserve stock; payment is wallet-only (no online top-up in the vendor app yet); the vendor app does not register an FCM token yet, so pushes only reach it once it does.
