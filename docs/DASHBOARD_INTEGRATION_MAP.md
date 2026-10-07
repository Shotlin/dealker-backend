# Dashboard Integration & API Mapping Specification

**Visual Source of Truth:** `meet-commerce-dashboard-mockup-pack/02-dashboard-mockups/` (15 Boards / 36 Dashboard Screens)  
**Backend API Source of Truth:** Meet Commerce Fastify Backend (`/api/v1/*`)  
**Specification Reference:** *Meet Commerce Backend Production Remediation Specification Version 1.0*

---

## Dashboard Screen to Backend API Mapping Matrix (Phases 1 - 7)

| Dashboard Screen / Board | Required UI Components | Backend API Endpoint | Database Source | Required Permission | Socket.IO Event | States Implemented |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **01. HQ Operations Command Center** | Executive KPIs, Revenue chart, Live Order Pipeline, Exception Queue | `GET /api/v1/admin/dashboard/summary` | `orders`, `inventory_lots`, `qc_inspections`, `v_daily_analytics` | `reports.global_view` | `order:status:updated` | Skeleton, Empty, Error, Permission Denied |
| **02. Orders & Cutting Evidence** | Order table, Status filters, Line items, Cutting evidence video player | `GET /api/v1/orders`, `GET /api/v1/orders/:id`, `POST /api/v1/orders/:id/cancel` | `orders`, `order_items`, `order_status_history` | `shop_orders.view` | `order:status:updated` | Loading Spinner, Empty List, 403 Access Denied |
| **03. Warehouse Receiving & QC** | Arrival stepper, QC checklist, Discrepancy weights, Acceptance decision form | `GET /api/v1/warehouse/arrivals`, `POST /api/v1/warehouse-receipts/:id/submit-qc` | `warehouse_receipts`, `qc_inspections`, `inventory_lots` | `quality_control.decide` | `warehouse:receipt:created` | Progress Bar, Empty Arrivals, Error Toast |
| **04. Catalogue, Vendors & Procurement** | Product proposals table, Vendor onboarding queue, Purchase order builder | `GET /api/v1/catalogue/proposals`, `GET /api/v1/vendors`, `POST /api/v1/procurement/requests` | `product_proposals`, `vendors`, `procurement_orders` | `product_proposals.view`, `procurement.create` | `vendor:application:submitted` | Shimmer, Empty Queue, API Error |
| **05. Inventory, Fulfilment & Delivery** | Lot table, FEFO expiry indicator, Picker assignment, Delivery live map | `GET /api/v1/inventory/lots`, `GET /api/v1/deliveries`, `POST /api/v1/deliveries/:id/assign` | `inventory_lots`, `fulfilment_tasks`, `delivery_assignments` | `inventory_lots.view`, `delivery_tasks.assign` | `delivery:location:update` | Loading Skeleton, Empty Lots, Map Degraded |
| **06. CRM, Support & Recalls** | Support tickets inbox, Complaint detail, Refund recommendation, Recall trigger | `GET /api/v1/support/tickets`, `POST /api/v1/admin/recalls/:id/activate` | `support_tickets`, `quality_complaints`, `product_recalls` | `support.ticket.view`, `recalls.activate` | `support:ticket:created` | Ticket Shimmer, Empty Inbox, Error Toast |
| **07. Finance & Loyalty** | GMV metrics, Settlement reconciliation, Provider event exceptions, Wallet holds | `GET /api/v1/admin/analytics/financial`, `GET /api/v1/admin/payments/reconciliation/runs` | `payment_reconciliation_runs`, `wallet_ledger_entries` | `finance.global_view` | `payment:captured` | Metric Shimmer, Empty Runs, 403 Forbidden |
| **08. Marketing & Content** | Campaign calendar, Coupon usage caps, Banner scheduler, Theme builder | `GET /api/v1/coupons`, `GET /api/v1/banners`, `POST /api/v1/admin/sections/:id` | `coupons`, `banners`, `app_themes` | `shop_coupons.view` | `section:update` | Content Skeleton, Empty List, Validation Error |
| **09. Analytics & Governance** | Executive KPI drilldown, Category mix, Audit log explorer, Role/permission matrix | `GET /api/v1/admin/audit-logs`, `GET /api/v1/admin/analytics/sales` | `audit_logs`, `daily_order_metrics` | `audit_logs.view` | N/A | Table Skeleton, Empty Logs, Error Alert |
| **11. Auth, Retention & Platform** | Login, 2FA challenge modal, Scope selector, Abandoned cart summary, App versions | `POST /api/v1/admin/auth/login`, `POST /api/v1/admin/auth/select-shop`, `GET /api/v1/app/version-check` | `users`, `sessions`, `user_2fa_settings`, `vendor_users` | Public / Scoped Session | N/A | Form Loading, Invalid Credentials, Session Expired |
| **12. Merchandising & Shops** | Shop list, Shop staff permissions, Cart milestones, Purchase limits | `GET /api/v1/shops`, `GET /api/v1/cart-milestones`, `GET /api/v1/purchase-limits` | `shops`, `shop_staff`, `cart_milestones`, `purchase_limit_rules` | `shops.view` | N/A | Card Skeleton, Empty Shops, Error Modal |
| **13. Content Configuration** | Theme versions, Payment methods toggle, Fee rules, Notification templates | `GET /api/v1/admin/settings`, `GET /api/v1/admin/notification-templates` | `system_settings`, `notification_templates` | `reports.global_view` | N/A | Loading Overlay, Default Values, Error Toast |
| **14. Universal States & Drawers** | Manual order creation drawer, Loading state, Empty state, 403 State, Bulk actions | All canonical CRUD APIs | All canonical DB tables | Standard RBAC | All events | Native Skeleton, Empty Graphic, Error Banner |
| **15. Supply-Chain Detail** | Vendor documents review, Batch timeline, QC evidence player, Lot adjustments | `GET /api/v1/vendor-kyc/documents`, `GET /api/v1/supply-batches/:id/timeline` | `vendor_documents`, `supply_batch_status_history`, `qc_evidence` | `batch_evidence.view` | `supply_batch:ready` | Detail Skeleton, Empty Timeline, 403 Scope Error |

---

## Universal UI State Contract (Phase 6)

Every connected dashboard component strictly implements 5 standard states:
1. **Loading State:** Native shimmer skeletons matching component dimensions without layout shift.
2. **Data State:** Server-authoritative data fetched directly from REST `/api/v1/` endpoints.
3. **Empty State:** Context-specific graphic, empty title, helper description, and primary CTA button.
4. **Error State:** Red-accented alert banner, human-readable error message, error code badge, and "Retry" trigger.
5. **Permission Denied (403):** Shield icon graphic, "Access Denied" notice, required permission string badge, and "Switch Scope / Request Access" CTA.
