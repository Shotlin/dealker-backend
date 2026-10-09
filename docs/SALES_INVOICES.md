# Sales invoices (B2C + B2B)

Migration `190_sales_invoices.sql`. Module `src/modules/sales-invoices`. Dashboard: **Invoices** (`/invoices`) — tabs **All · B2B · B2C · Purchase documents**. The existing seller *purchase* invoices (migration 178) are untouched and live in the last tab.

## What is issued
| Document | When |
|---|---|
| **Tax invoice** | Seller has a valid GSTIN |
| **Bill of supply** | Seller is not GST-registered *and* the sale carries no GST |
| **Credit note** | Against an invoice: line-by-line, partial or full |
| **Debit note** | Against an invoice: extra charges |

Sources: **repairs** (automatic on completion), **marketplace seller orders** (on request, guarded — see below), **manual** (offline B2B sales, auctions, anything staff must bill).

## Guarantees (enforced in the database, not just the UI)
* **Gapless numbers per seller.** GST requires a consecutive series per registration, so each issuer has its own: `CI/26-27/000001` (B2C invoice), `BI/…` (B2B invoice), `BS/…`, `CN/…`, `DN/…`; ≤ 16 characters; resets each April. The number is allocated in the same transaction that stores the PDF, so a failure never burns a number (tested, including a simulated disk-full).
* **Immutable.** A DB trigger rejects any update or delete of an issued document; the PDF attaches exactly once. Corrections are credit/debit notes. The audit trail (`ISSUED / VIEWED / DOWNLOADED / CREDIT_NOTE_ISSUED …`) is append-only.
* **One invoice per source.** Issuing a repair/order twice, even in parallel, returns the first invoice.
* **Archive integrity.** The PDF is rendered once from the stored snapshot, kept in private storage, and its SHA-256 is verified on every download; a tampered or missing file is never served. Every view/download is logged with the actor.
* **Exact money.** Integer-paise maths; document totals are sums of rounded lines; credit notes can never exceed the invoice (row-locked, tested under parallel load); the last credit on a line takes exactly the remainder.
* **No fabricated e-invoicing.** `irn_status = NOT_INTEGRATED`; no IRN or QR code is ever drawn.

## Tax treatment applied
* **Supply type:** place of supply = buyer's state (from GSTIN for B2B, delivery/billing state for B2C). Same state as the seller → CGST + SGST (half each); otherwise IGST. If a B2C buyer's state is unknown, the seller's state is used and the invoice says so (`*`).
* **Seller identity:** from the vendor's legal profile (KYC). A seller with no legal name / address / state is refused (`ISSUER_PROFILE_INCOMPLETE`); a seller without a GSTIN cannot charge GST (`ISSUER_NOT_GST_REGISTERED`). The platform's own details (Invoice settings) are used only when the platform itself is the seller.
* **Repairs:** lines come from the approved estimate; services use the SAC and parts the HSN set in Invoice settings. The invoice total equals the amount the customer was charged (a ≤ ₹1 round-off is shown if the estimate's rounding differs). Declined/unrepairable repairs are invoiced for the diagnostic fee only, tax-inclusive, at exactly the amount charged.
* **Seller orders:** checkout today adds GST on each item's *undiscounted* subtotal at the product's *current* rate and stores no per-line tax snapshot. So an order is invoiced only when recomputing that tax reproduces the tax charged on the order (`TAX_MISMATCH` otherwise), and orders that used any discount, coupon or points are refused (`TAX_BASIS_UNSUPPORTED`). Delivery is shown as an untaxed line, as charged. This is a deliberate guard, not a gap to paper over: it needs the tax-profile layer (per-line rate/HSN snapshot at checkout).

## Permissions
`sales_invoices.view` · `.issue` · `.credit` · `.export` · `.settings` (all granted to Platform Admin by the migration). Vendors read, export and download only the documents they issued; customers only their own. Vendors cannot issue, credit or change settings.

## API
**Customer app** (`/api/v1/sales-invoices`, bearer): `GET /` (own documents; filters `docType, from, to, q, page`) · `GET /:id` · `GET /:id/pdf[?download=1]`.
**Dashboard / vendors** (`/api/v1/manage/sales-invoices`): `GET /` (`channel, docType, q, from, to, issuerVendorId, page, limit`) · `GET /:id` (lines, tax summary, `creditable` quantities, credit/debit notes, history) · `GET /:id/pdf[?download=1]` · `GET /export` (CSV, ≤ 5,000 rows, credit notes negative) · `GET /for/repair|order/:id` · `POST /issue/repair/:id` · `POST /issue/order/:id` · `POST /` (manual: `{channel, issuerVendorId?, buyer, lines:[{description, hsnSac, qty, unitPrice, discount?, taxRate}], taxInclusive?, orderRef?, poReference?, dueDate?, notes?}`) · `POST /:id/credit-notes {reason, lines:[{index, qty?}]}` · `POST /:id/debit-notes {reason, lines}` · `GET|PUT /settings`.
PDFs are returned with `Cache-Control: no-store`, `nosniff` and a sandbox CSP; fetch them with the bearer token (not a public link) and save/open the blob.
Error codes: `ISSUER_PROFILE_INCOMPLETE, ISSUER_NOT_GST_REGISTERED, NOT_BILLABLE, TAX_MISMATCH, TAX_BASIS_UNSUPPORTED, TOTAL_MISMATCH, OVER_CREDIT, INVALID_STATE, INTEGRITY_FAILED, FILE_MISSING, VALIDATION`.

## Deployment
1. `npm run db:migrate` (additive). 2. `PRIVATE_UPLOAD_DIR` must be on a persistent, **backed-up** volume — invoice PDFs live in `sales-invoices/<FY>/`. 3. Fill **Invoices → Settings** if the platform itself sells anything. 4. Make sure each seller's legal profile (name, GSTIN, address, state) is complete, or their invoices will be refused with the reason shown.

## Have an accountant confirm before go-live
* SAC/HSN defaults for repairs (`9987` / `8517`), and the single 18% repair rate.
* Place-of-supply assumption for B2C buyers whose state is unknown.
* Numbering format/series per seller, and the rules/time limits for issuing credit notes after the financial year.
* Whether the platform must issue its own invoices for commission/fees to sellers (not built — see below).
* Whether any seller needs e-invoicing (IRN/QR) — not integrated.

## Not built
* **IRN / QR (e-invoice)** and e-way bills.
* **Platform → seller commission invoices** (the platform's own tax invoice for its fee) and auction-fee invoices — use manual issue meanwhile.
* **Tax profiles** (new/used goods, margin scheme, per-line rate/HSN snapshot at checkout) — needed before discounted marketplace orders can be invoiced automatically.
* **Supporting-document uploads**, bulk ZIP of PDFs, invoice email/WhatsApp delivery, company logo on the PDF, multi-language.
* **Payment allocation on manual invoices** (shown as "not tracked"); repair and order invoices show live payment status.
* Customer/vendor **mobile screens** — only the API above.
