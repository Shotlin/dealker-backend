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

## Not built yet (be explicit before go-live)
* **Repair invoice / warranty PDF:** there is no sales-invoice module in the platform yet (only seller purchase invoices), so none is generated. The completed repair carries the figures and warranty date that an invoice will need.
* **Online payment:** payments are recorded by staff (cash/UPI/card/bank/COD/wallet). Razorpay checkout for repair invoices is not wired.
* **Settlement posting:** commission/payable is snapshotted, not posted to `settlement_ledger`.
* **Spare-part inventory & per-part pricing master:** parts are free-text lines.
* **Several authorised purchasers per business:** a request belongs to one user account; the approver is recorded as text when staff approve on a business's behalf.
* **GST on repairs:** a single configurable rate (default 18%). Confirm service vs. parts rates with your accountant.
* **Customer/vendor mobile screens** are not in this workspace; only the API above is provided.
