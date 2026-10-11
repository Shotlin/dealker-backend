# Repairs (B2C + B2B)

Migration `189_repairs.sql` (additive). Module `src/modules/repairs`. Dashboard: **Repair Service → Repair Requests** (`/repairs`) and `/repairs/settings`.

One lifecycle serves both channels. **B2C** = an individual with 1–3 devices (limit configurable). **B2B** = a business with many devices, GSTIN, PO reference, an authorised contact, optional contract discount and credit terms, partial delivery.

## Lifecycle (enforced on the server; no skipped steps)

`REQUESTED → ACCEPTED → INSPECTION → ESTIMATE_SENT → ESTIMATE_APPROVED → IN_REPAIR → QC_PENDING → REPAIRED → READY_FOR_DELIVERY → COMPLETED`

Side exits: `REJECTED` (admin, from REQUESTED) · `CANCELLED` (customer/admin, only before the device arrives) · `ESTIMATE_REJECTED` (customer declines; device returned, diagnostic fee due) · `FAILED` (cannot be repaired; device returned) · QC failure → back to `IN_REPAIR` (rework counted) · `COMPLETED → IN_REPAIR` (warranty claim, only within `warranty_until`). Returned devices go through `READY_FOR_DELIVERY`, so nothing leaves without a record.

## Rules the server applies
* **Pricing:** clients send line items (`LABOUR | PART | DIAGNOSTIC | OTHER`, qty, unit price). The server computes subtotal → contract discount → GST → total in integer paise. Any `total`/`tax` sent by a client is ignored. Every repairable device must be priced. Estimates expire (`estimate_validity_days`).
* **Advance:** `advance_pct` of the approved total must be recorded before work starts (`ADVANCE_REQUIRED`). Skipped for businesses with approved credit terms.
* **Delivery:** blocked while money is due (`PAYMENT_DUE`) or excess is unrefunded (`REFUND_PENDING`); credit-terms businesses are delivered on credit and get a `due_date`. B2B can deliver in parts; the repair completes when every device is delivered.
* **Credit:** terms apply only if the business has a credit limit; approving an estimate that would exceed it → `CREDIT_LIMIT`.
* **Payments:** append-only, idempotent per `(request, idempotencyKey)`, row-locked (parallel replays record once; parallel payments can never exceed what is due), refunds need a reason and cannot exceed the overpayment.
* **Diagnostic fee** is charged per device not in warranty when an estimate is declined or the device is unrepairable.
* **Completion** snapshots warranty end date and the platform commission / service-centre payable (on the pre-tax amount). *This snapshot is stored on the request; it is not yet posted to the vendor settlement ledger.*
* **Isolation:** customers see only their own requests; a service centre sees only requests assigned to it; platform staff need `repairs.*` permissions (`view`, `manage`, `finance` for payments/refunds, `settings`).
* One live repair per IMEI/serial. GSTIN format validated.

## Customer-app API (`/api/v1/repairs`, bearer auth)
| Method & path | Notes |
|---|---|
| `GET /config` | Enabled channels, limits, diagnostic fee, warranty days, active service price list |
| `POST /` | `{channel:"B2C"\|"B2B", items:[{brand,model,imeiSerial?,problemCategory,problemDescription?,warrantyStatus?,category?,accessories?}], serviceMode:"PICKUP"\|"DROP_OFF", pickupAddress?, pickupSlot?, description?, mediaIds?, customer:{city?}}`; B2B adds `businessName, gstin, contactPerson, poReference?` |
| `GET /mine`, `GET /:id` | Own requests with items, estimates, payments, timeline, media |
| `POST /:id/approve-estimate` · `POST /:id/reject-estimate {reason}` · `POST /:id/cancel {reason}` · `POST /:id/reopen {reason, itemIds?}` | Customer decisions |
| `POST /media` (multipart `files`, one per call) · `DELETE /media/:id` · `POST /:id/media {mediaIds, stage, itemId?}` · `GET /media/:id/link` | Same private storage, content checks and signed links as sell-request evidence. Customer stages: `CUSTOMER_SUBMISSION`, `DISPUTE` |

## Dashboard / service-centre API (`/api/v1/manage/repairs`)
`GET /stats` · `GET /` (`channel, tab, q, overdue, page, limit`) · `GET /:id` · `POST /` (book on behalf)
Actions `POST /:id/…`: `accept {vendorId, technicianId?}` · `reject {reason}` · `assign` · `cancel` · `receive` · `quotes {lines, note?}` · `approve-estimate {note}` (on the customer's behalf; reference required) · `reject-estimate` · `start` · `send-to-qc` · `qc {results:[{itemId,passed,notes?}]}` · `fail {reason}` · `ready` · `deliver {itemIds?}` · `reopen` · `payments {kind,method,amount,reference?,note?,idempotencyKey}` · `items/:itemId/diagnosis {diagnosis, repairable}`
Config: `GET/PUT /config/settings` · `GET/POST /config/services`, `PUT /config/services/:id` · `GET/PUT /config/terms`.
Files: `GET /api/v1/media/repair-evidence/:id?exp&sig` (signed, 30–45 min).

Error codes: `INVALID_STATE, ADVANCE_REQUIRED, PAYMENT_DUE, REFUND_PENDING, OVERPAYMENT, REFUND_TOO_HIGH, QUOTE_EXPIRED, UNPRICED_DEVICE, CREDIT_LIMIT, WARRANTY_EXPIRED, DEVICE_ACTIVE, CHANNEL_DISABLED, DISABLED, NO_SERVICE_CENTER, VALIDATION`.

## Quote marketplace (migration `202_repair_marketplace.sql`, `repairs.market.js`)

The customer flow: **Create request → nearby shops quote → compare → choose pickup & delivery or a shop appointment → track → completed → rate.** It runs on top of the lifecycle above; after the customer picks an offer the request is `ACCEPTED` with that vendor assigned, and everything else (inspection, QC, payments, invoice, warranty) is unchanged.

A request is a *marketplace* request (`flow = MARKETPLACE`) when a B2C customer sends `addressId` or `location {lat,lng,pincode}` (or `marketplace:true`). Requests without a location, staff-booked requests and B2B stay on the original admin-assigned (`DIRECT`) flow.

**Offers.** On creation the server prices the request from every in-range vendor's price list (`repair_vendor_services`) and stores a *live quote* (`repair_offers`, `source = AUTO`) — only from vendors that price **every** issue of **every** device. In range = a shop within `search_radius_km` (haversine) or serving the customer's pincode. Vendors can also quote by hand while the window (`offer_window_hours`) is open (`MANUAL`); a hand-written quote is never overwritten by an automatic one. Totals are computed server-side (parts + labour + GST); a client `total` is ignored. One offer per vendor per request; at most `max_offers` open.

**Selecting.** `POST /repairs/:id/offers/:offerId/select` is one transaction (request and offer row-locked): the chosen offer becomes `SELECTED`, the others `NOT_SELECTED`, the vendor is assigned, and fulfilment is stored — `PICKUP_DELIVERY` (address + optional slot) or `SHOP_VISIT` (appointment time required). Parallel selects: exactly one wins, the other gets `409`.

**Privacy.** Before selection a vendor sees only first name, pincode, distance, devices, issues and the customer's photos. Phone and full address are released once chosen.

**After selection** (service centre, `…/manage/repairs/:id/…`): `schedule-pickup` → `picked-up` → `receive` (blocked until picked up) → `confirm-price` (INSPECTION → ESTIMATE_APPROVED at exactly the offer total; or send a revised estimate the customer must approve) → `start` → `send-to-qc` → `qc` → `ready` → `out-for-delivery {courier?, trackingUrl?}` → `deliver` (blocked until out for delivery, and while money is due). Shop-visit requests skip pickup and out-for-delivery. Service centres may record advance/balance payments on marketplace requests (not refunds).

**Tracking.** `GET /repairs/:id/tracking` returns the customer's steps with done/current/time: pickup flow — Request Accepted · Pickup Scheduled · Device Picked Up · At Repair Shop · Repair in Progress · Quality Check · Out for Delivery · Delivered; shop flow — Request Accepted · Appointment Booked · Device Received at Shop · Repair in Progress · Quality Check · Ready for Pickup · Collected. **Status only: no live location, no rider, no map** (optional courier name and tracking link).

**Rating.** `POST /repairs/:id/rate {stars 1–5, review?}` once, after `COMPLETED`; shown as each vendor's rating and completed-repair count on later offers.

### Marketplace API
Customer (`/api/v1/repairs`): `GET /catalogue/brands` · `GET /catalogue/models?brand=` · `GET /devices/recent` · `GET /:id/offers?sort=best|lowest_price|nearest|highest_rating` · `POST /:id/offers/:offerId/select {fulfilment, addressId?|pickupAddress?, pickupSlot?, appointmentAt?}` · `GET /:id/tracking` · `POST /:id/rate`. `GET /config` also returns `issues` and `deviceTypes`; `POST /` accepts `items[].problemCategories[]` (several issues per device; new `TOUCH`, `NETWORK`).

Vendor / dashboard (`/api/v1/manage/repairs`): `GET /market/incoming?tab=new|quoted|all` · `GET /market/incoming/:id` · `GET /market/incoming/:id/media/:mediaId/link` · `POST|DELETE /market/incoming/:id/offer` · price list: `GET|POST /market/services`, `POST /market/services/bulk` (one device, many repairs), `PUT|DELETE /market/services/:id` · staff: `GET /:id/offers`, `GET /:id/tracking`, `POST /:id/{schedule-pickup,picked-up,out-for-delivery,confirm-price,generate-offers}`. Admins name `vendorId` when writing a vendor's price list or quote.

Settings (`/config/settings`): `marketplaceEnabled`, `autoQuoteEnabled`, `searchRadiusKm`, `offerWindowHours`, `maxOffers`. Dashboard: **Repair Service → Repair Requests** (quotes, fulfilment, tracking, rating in the detail panel) and **Vendor Price Lists** (`/repairs/services`).

### Vendor-app API map (what each vendor screen calls)
| Vendor screen | Calls |
|---|---|
| Add Repair Service (device, brand, model, parts + prices, "service available in nearby areas") | `POST /market/services/bulk` · `GET /market/services` · `PUT|DELETE /market/services/:id` · `GET|PUT /market/profile {acceptingRequests}` · brand/model lists: `GET /api/v1/repairs/catalogue/*` |
| Incoming Repair Requests (New / Accepted / Completed + counts) | `GET /market/incoming?tab=new|quoted|all` (returns `counts.new/quoted/accepted/completed`) · Accepted: `GET /?tab=active` · Completed: `GET /?tab=completed` |
| Request Details (customer, distance, device, IMEI, colour, issue, photos) | `GET /market/incoming/:id` · photo links `GET /market/incoming/:id/media/:mediaId/link` |
| Send Quote (parts & labour, time, warranty, pickup & delivery, note) | `GET /market/incoming/:id/suggested-quote` (pre-fill from price list) · `POST /market/incoming/:id/offer` · `DELETE …/offer` to withdraw |
| Active Orders (All / In progress / Completed, call, details) | `GET /?tab=active|completed` · `GET /:id` · customer phone is in the detail once chosen |
| Repair Process (Received → Repair → QC → Ready → Delivered, updates, photos/video, technician note, notify customer, mark completed) | `POST /:id/receive` · `/start` · `/send-to-qc` · `/qc` · `/ready` · `/out-for-delivery` · `/deliver` · `POST /:id/update {stage,note,notify,mediaIds}` · uploads `POST /media` + `POST /:id/media {stage:'REPAIR_PROGRESS'}` · payments `POST /:id/payments` |

Error codes added: `OUT_OF_RANGE, OFFERS_CLOSED, OFFERS_FULL, OFFER_UNAVAILABLE, OFFER_EXPIRED, FULFILMENT_UNAVAILABLE, ALREADY_RATED, DUPLICATE`.

Not built: the vendor mobile app and customer mobile screens; vendor push notification when a nearby request arrives; auto-expiry of requests nobody picked an offer for; chat; online payment of the advance.

## Not built yet (be explicit before go-live)
* **Repair invoice / warranty PDF:** there is no sales-invoice module in the platform yet (only seller purchase invoices), so none is generated. The completed repair carries the figures and warranty date that an invoice will need.
* **Online payment:** payments are recorded by staff (cash/UPI/card/bank/COD/wallet). Razorpay checkout for repair invoices is not wired.
* **Settlement posting:** commission/payable is snapshotted, not posted to `settlement_ledger`.
* **Spare-part inventory & per-part pricing master:** parts are free-text lines.
* **Several authorised purchasers per business:** a request belongs to one user account; the approver is recorded as text when staff approve on a business's behalf.
* **GST on repairs:** a single configurable rate (default 18%). Confirm service vs. parts rates with your accountant.
* **Customer/vendor mobile screens** are not in this workspace; only the API above is provided.
