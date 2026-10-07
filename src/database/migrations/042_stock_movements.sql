-- 042_stock_movements.sql
-- Multi-vendor: introduce the append-only `stock_movements` ledger that
-- records every change to `shop_products.stock_quantity` (manual
-- adjustments, order deductions, cancellation restores, damaged stock,
-- and customer returns). The ledger is the source of truth for inventory
-- traceability per Requirement 23 AC#1–AC#4 and is consumed by the
-- per-shop stock-history endpoint (R23 AC#5) and the audit pipeline
-- (R23 AC#14).
--
-- Append-only contract (R23 AC#3, design §17 "Property 6"):
--   * Application paths only INSERT and SELECT — never UPDATE, never
--     DELETE. The application PostgreSQL role (`bakaloo_app`) is granted
--     INSERT+SELECT only on this table; ALL is reserved for the
--     migration role (`bakaloo_admin`). This is enforced at deploy time
--     (design §10) and re-checked by a static grep in CI (design §17).
--   * The `COMMENT ON TABLE` below is the in-database reminder of that
--     contract; reviewers and DBAs see it via `\d+ stock_movements`.
--
-- Columns (per design §3.2.4 + R23 AC#1):
--   * id              UUID PK         — surrogate identifier.
--   * shop_id         UUID NOT NULL   — owning shop (FK shops).
--   * shop_product_id UUID NOT NULL   — affected per-shop SKU
--                                       (FK shop_products).
--   * product_id      UUID NOT NULL   — denormalized master product
--                                       (FK products) so historical rows
--                                       survive Shop_Product soft-delete
--                                       and remain queryable across
--                                       shops.
--   * type            VARCHAR(30)     — Stock_Movement_Type; vocabulary
--                                       pinned by `chk_stock_movements_type`.
--   * quantity_delta  INTEGER         — signed delta (negative for
--                                       deductions, positive for
--                                       restores/returns/manual
--                                       increases).
--   * quantity_before INTEGER NOT NULL
--                                     — stock_quantity at the moment
--                                       SELECT FOR UPDATE locked the
--                                       Shop_Product row; CHECK >= 0
--                                       because the Platform never
--                                       allows a negative balance to be
--                                       observed (R23 AC#9 rejects with
--                                       STOCK_NEGATIVE_FORBIDDEN).
--   * quantity_after  INTEGER NOT NULL
--                                     — stock_quantity after the
--                                       transaction commits;
--                                       CHECK >= 0, same rationale.
--   * reason          VARCHAR(500)    — operator-supplied free-text;
--                                       nullable for system-emitted
--                                       movements (ORDER_DEDUCTION,
--                                       CANCELLATION_RESTORE).
--   * order_id        UUID            — FK orders; populated for
--                                       ORDER_DEDUCTION /
--                                       CANCELLATION_RESTORE /
--                                       RETURN_STOCK rows so the order
--                                       lineage is recoverable from the
--                                       ledger alone.
--   * actor_user_id   UUID            — FK users; the User who initiated
--                                       the change (NULL when the source
--                                       is JOB and no human acted).
--   * actor_shop_role VARCHAR(50)     — snapshot of the actor's
--                                       Shop_Staff_Record role at write
--                                       time (e.g. SHOP_ADMIN,
--                                       SHOP_MANAGER) so audit trails
--                                       survive subsequent role changes.
--   * source          VARCHAR(20) NOT NULL
--                                     — origin channel; vocabulary
--                                       pinned by
--                                       `chk_stock_movements_source`.
--   * metadata        JSONB DEFAULT '{}'::jsonb
--                                     — request-scoped context (e.g.
--                                       request_id, batch_id for bulk
--                                       price updates, manual-create
--                                       flag); kept loosely typed so new
--                                       integrations can add fields
--                                       without a migration.
--   * created_at      TIMESTAMPTZ DEFAULT NOW()
--                                     — write timestamp; ledger rows are
--                                       immutable so this also serves as
--                                       the effective-at timestamp.
--
-- CHECK constraints:
--   * chk_stock_movements_type   — enforces Stock_Movement_Type
--                                  vocabulary (R23 AC#2).
--   * chk_stock_movements_source — enforces channel vocabulary
--                                  (DASHBOARD | ORDER | JOB | API).
--
-- Indexes (per design §3.2.4):
--   * idx_stock_movements_shop_created — `(shop_id, created_at DESC)`.
--                                        Powers the Store_Mode
--                                        "Stock movements" tab default
--                                        listing and the
--                                        GET /api/v1/shops/:shopId/stock-movements
--                                        endpoint (R23 AC#5).
--   * idx_stock_movements_shop_product — `(shop_product_id, created_at DESC)`.
--                                        Per-product history drill-down
--                                        on the Store_Mode product
--                                        detail page.
--   * idx_stock_movements_product      — `(product_id)`. Cross-shop
--                                        lookups by master product (HQ
--                                        analytics, master-catalog
--                                        traceability).
--   * idx_stock_movements_order        — partial `(order_id) WHERE
--                                        order_id IS NOT NULL`. Powers
--                                        order-detail "stock impact"
--                                        view without bloating the
--                                        index with the (majority)
--                                        non-order rows.
--   * idx_stock_movements_actor        — partial `(actor_user_id) WHERE
--                                        actor_user_id IS NOT NULL`.
--                                        Powers the actor filter in the
--                                        movements endpoint (R23 AC#5)
--                                        without indexing the system
--                                        rows.
--   * idx_stock_movements_type         — `(shop_id, type, created_at DESC)`.
--                                        Powers the type-filtered
--                                        ledger view per shop.
--
-- Idempotent: re-running this migration is a no-op. Table creation uses
-- `CREATE TABLE IF NOT EXISTS` (which carries its inline CHECK
-- constraints atomically with the table) and every index uses
-- `CREATE INDEX IF NOT EXISTS`. The `COMMENT ON TABLE` is unconditionally
-- safe to re-issue.
--
-- Note: this migration only ships the schema. The INSERT call sites
-- (manual-create flow, adjust-stock endpoint, order deduction worker,
-- cancellation/return restore paths) live in tasks 5.x and 6.x; the
-- DB-role grant that operationally enforces append-only is wired in the
-- deploy script per design §10.
--
-- Requirements: R23.1, R23.2, R23.3, R23.4
-- Design:       §3.2.4 of .kiro/specs/multi-vendor-system/design.md

CREATE TABLE IF NOT EXISTS stock_movements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shop_id         UUID NOT NULL REFERENCES shops(id),
  shop_product_id UUID NOT NULL REFERENCES shop_products(id),
  product_id      UUID NOT NULL REFERENCES products(id),
  type            VARCHAR(30) NOT NULL,
  quantity_delta  INTEGER NOT NULL,
  quantity_before INTEGER NOT NULL CHECK (quantity_before >= 0),
  quantity_after  INTEGER NOT NULL CHECK (quantity_after >= 0),
  reason          VARCHAR(500),
  order_id        UUID REFERENCES orders(id),
  actor_user_id   UUID REFERENCES users(id),
  actor_shop_role VARCHAR(50),
  source          VARCHAR(20) NOT NULL,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT chk_stock_movements_type CHECK (type IN
    ('MANUAL_ADJUSTMENT','ORDER_DEDUCTION','CANCELLATION_RESTORE','DAMAGED_STOCK','RETURN_STOCK')),
  CONSTRAINT chk_stock_movements_source CHECK (source IN
    ('DASHBOARD','ORDER','JOB','API'))
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_shop_created ON stock_movements(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_shop_product ON stock_movements(shop_product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product      ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_order        ON stock_movements(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_actor        ON stock_movements(actor_user_id) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_movements_type         ON stock_movements(shop_id, type, created_at DESC);

COMMENT ON TABLE stock_movements IS
  'Append-only stock movement ledger. Application role MUST hold INSERT+SELECT only.';
