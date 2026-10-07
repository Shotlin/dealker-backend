-- Migration 071: Quick Delivery surcharge config + global store open/closed status
-- Idempotent (IF NOT EXISTS / DO $$ checks before adding columns)

-- ─── fee_settings: Quick Delivery surcharge (flat, admin-configurable) ────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fee_settings' AND column_name = 'quick_delivery_surcharge_enabled'
  ) THEN
    ALTER TABLE fee_settings ADD COLUMN quick_delivery_surcharge_enabled BOOLEAN NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fee_settings' AND column_name = 'quick_delivery_surcharge_amount'
  ) THEN
    ALTER TABLE fee_settings ADD COLUMN quick_delivery_surcharge_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fee_settings' AND column_name = 'quick_delivery_surcharge_label'
  ) THEN
    ALTER TABLE fee_settings ADD COLUMN quick_delivery_surcharge_label VARCHAR(60) NOT NULL DEFAULT 'Quick delivery fee';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_fs_quick_surcharge'
  ) THEN
    ALTER TABLE fee_settings ADD CONSTRAINT chk_fs_quick_surcharge
      CHECK (quick_delivery_surcharge_amount >= 0);
  END IF;
END $$;

-- ─── store_status: single global row — is the (one) storefront open right now ─
-- Priority: manual_override_status (if set) > weekly_hours evaluation > fail-open.
CREATE TABLE IF NOT EXISTS store_status (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  manual_override_status  VARCHAR(10) NULL,
  manual_override_note    TEXT NULL,
  manual_override_set_at  TIMESTAMPTZ NULL,
  manual_override_set_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  weekly_hours            JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_store_status_override'
  ) THEN
    ALTER TABLE store_status ADD CONSTRAINT chk_store_status_override
      CHECK (manual_override_status IN ('OPEN', 'CLOSED'));
  END IF;
END $$;

-- Seed the single singleton row if the table is empty.
INSERT INTO store_status (id)
SELECT uuid_generate_v4()
WHERE NOT EXISTS (SELECT 1 FROM store_status);

-- ─── orders: snapshot of what was actually charged for Quick Delivery ────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'quick_delivery_selected'
  ) THEN
    ALTER TABLE orders ADD COLUMN quick_delivery_selected BOOLEAN NOT NULL DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'quick_delivery_surcharge_amount'
  ) THEN
    ALTER TABLE orders ADD COLUMN quick_delivery_surcharge_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00;
  END IF;
END $$;
