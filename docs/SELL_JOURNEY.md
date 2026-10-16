# Sell your phone (customer → verified buyers)

Migration `204_sell_phone_journey.sql`. Backend `modules/sell-requests/sell-journey.service.js` (+ routes in `sell-requests.routes.js`). Dashboard: **Sell on Phone → Sell Requests** (Sale progress panel), **Sell Payouts**, **Blocked IMEIs**, Settings → *Selling journey*. Customer app: `lib/features/sell_phone/` (`/sell`).

A customer can only sell to **verified, active vendors** (buyers). There is no customer-to-customer sale: a listing is visible only to vendors, who make offers.

## Journey

| # | Step | Server |
|---|---|---|
| 1–2 | Brand / model / storage / colour | `GET /sell-requests/catalog` (shared with Exchange) |
| 3–5 | IMEI scan or type → eligibility | `POST /sell-requests/verify-imei` → checks FORMAT (Luhn), BLOCKLIST, NO_LIVE_REQUEST, SOLD_BEFORE (warn), CEIR (info only) |
| 6 | Condition checklist + photos | `POST /sell-requests/media` (private evidence) |
| 7 | Price band + nearby buyers | `POST /sell-requests/estimate` → `estimateMin/Max` (system valuation ± `estimate_spread_pct`), `vendorsNearby`, `offerWindowMinutes` |
| list | Create | `POST /sell-requests {…, imeiCheckId, mediaIds, location}` — offer window opens (`offers_close_at`) |
| 8 | Compare offers | `GET /:id/offers` (named buyers, rating, distance, best flag, validity) · `POST /:id/offers/refresh` (limited) |
| 9–10 | Accept an offer | `POST /:id/offers/:offerId/accept` — exclusive, others declined, buyer must now pay |
| 9 | Pickup / drop-off | `POST /:id/fulfilment {fulfilment: PICKUP\|DROP_OFF, addressId\|address+pincode, date, window, note}` |
| – | Buyer pays Dealker (held) | vendor `POST /manage/sell-requests/:id/vendor-payment {method, reference, idempotencyKey}` → finance `…/vendor-payment/confirm` → `HELD` |
| 11–12 | Courier pickup + tracking | `POST …/pickup {provider, awb, courierName, trackingUrl}` · `…/pickup/status` · `…/pickup/sync` · courier webhook (same `/shipping` webhook as returns) · `…/received` |
| 13 | Inspection / final price | existing request QC (`…/qc/*`) run by the assigned buyer; final price ≤ accepted offer; unchanged price is accepted automatically, a cut waits for `POST /:id/qc/decision {ACCEPT\|DECLINE}` |
| 14–16 | Payout | `POST /:id/payout {method: UPI\|BANK\|WALLET, upiId \| bank{…}}` → wallet instant; UPI/bank → finance queue → `…/payout/paid {reference}` |
| any | One call for the app | `GET /:id/journey` → `stage`, `nextAction`, `steps[]`, buyer, courier, inspection, payout, `payoutOptions` |

`nextAction` ∈ WAIT_FOR_OFFERS · REFRESH_OFFERS · CHOOSE_FULFILMENT · WAIT_FOR_BUYER_PAYMENT · WAIT_FOR_PICKUP_SLOT · WAIT_FOR_PICKUP · DROP_OFF_DEVICE · WAIT_FOR_DELIVERY_TO_BUYER · WAIT_FOR_INSPECTION · DECIDE_FINAL_PRICE · CHOOSE_PAYOUT · PAYOUT_PROCESSING · DONE · DEVICE_RETURNING · CLOSED.

## Money (append-only `sell_payments`)
* **Buyer funding** — the buyer pays the accepted amount to Dealker first (recorded with a UTR, finance confirms). Pickup and receipt are blocked until it is `HELD` (`require_vendor_funding`, default on).
* **Customer payout** — never more than the amount held. Wallet is credited instantly (only when it fits the wallet balance cap — default ₹2,000, so phone payouts normally go UPI/bank). UPI/bank enter **Sell Payouts**; finance sends the transfer and marks it paid with the bank reference. Payout details are AES-GCM encrypted and shown masked everywhere except to finance (`sell_requests.finance`), where each view is logged.
* **Price drop at inspection** — the difference is queued as a refund to the buyer. **Declined / failed / cancelled after pickup** — the phone goes back (`RETURNING`) and the buyer's money is queued for refund.

## What is deliberately not automated
* **IMEI blacklist (CEIR/KYM)** has no public API (OTP web form / SMS). We run checksum, our own blocklist, duplicate and sold-before checks; the buyer checks CEIR at inspection. A paid provider can be added in `verifyImei`.
* **Instant UPI/bank payouts** need RazorpayX enabled on the Razorpay account; the finance queue is the hand-off point to plug it in (`releasePayout`).
* **Courier booking** is recorded (Shiprocket / Porter / Blue Dart / own team) and then tracked by AWB or webhook — same approach as customer returns. No live location anywhere.
* Vendor app screens for these steps are not built; the API above is what they call.

## Settings (`PUT /manage/sell-requests/settings`)
`offerWindowMinutes`, `maxOfferRefreshes`, `estimateSpreadPct`, `requireVendorFunding`, `pickupEnabled`, `dropoffEnabled`, `payoutWalletEnabled`, `payoutUpiEnabled`, `payoutBankEnabled`.

## Negotiation (migration 209)
The customer **names their own price** (`expectedPrice` on `POST /sell-requests`; the estimate is only a suggestion; above 2× the model's base price → `ASKING_PRICE_TOO_HIGH`). Buyers offer, then the two sides talk before the customer accepts — one thread per (request, vendor), table `sell_request_messages`.

| Who | Endpoint |
|---|---|
| Customer | `GET /sell-requests/:id/threads` (buyers who offered or wrote, last line, unread) · `GET /:id/threads/:vendorId` (marks read) · `POST /:id/threads/:vendorId/messages {body}` |
| Vendor | `GET /manage/sell-requests/:id/messages` · `POST …/messages {body}` (may start a thread without an offer) |

Rules: max 1000 chars, 300 messages per thread; closed when another buyer's offer is accepted or the sale ends (`THREAD_CLOSED`); phone numbers are blocked until an offer is accepted (`NO_CONTACT_DETAILS`); the customer appears to vendors only as "Seller"; the other side gets a push (`sell_request:message_from_vendor|customer`). `GET /mine` rows carry `askingPrice, imageUrl, offerCount, bestOffer, unreadMessages`; `/offers` carries `askingPrice` and per-offer `unread`. Landing artwork: `hubBannerUrl` / `hubStepIcons` (3 URLs) in `journey-config` and `PUT /manage/sell-requests/settings`. Vendor-side chat UI is not built yet.
