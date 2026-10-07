-- Migration 053: Add delivery slot / scheduled delivery fields to orders table
-- Idempotent (IF NOT EXISTS / DO $$ checks before adding columns)

DO $$
BEGIN
  -- delivery_mode: ASAP (default) or SCHEDULED
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'delivery_mode'
  ) THEN
    ALTER TABLE orders ADD COLUMN delivery_mode VARCHAR(20) NOT NULL DEFAULT 'ASAP';
  END IF;

  -- scheduled_delivery_at: user-facing target delivery start (UTC)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'scheduled_delivery_at'
  ) THEN
    ALTER TABLE orders ADD COLUMN scheduled_delivery_at TIMESTAMPTZ NULL;
  END IF;

  -- scheduled_slot_start: slot window start (UTC)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'scheduled_slot_start'
  ) THEN
    ALTER TABLE orders ADD COLUMN scheduled_slot_start TIMESTAMPTZ NULL;
  END IF;

  -- scheduled_slot_end: slot window end (UTC)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'scheduled_slot_end'
  ) THEN
    ALTER TABLE orders ADD COLUMN scheduled_slot_end TIMESTAMPTZ NULL;
  END IF;

  -- scheduled_slot_label: human-readable label e.g. "Today, 7:00 PM – 9:00 PM"
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'scheduled_slot_label'
  ) THEN
    ALTER TABLE orders ADD COLUMN scheduled_slot_label TEXT NULL;
  END IF;
END $$;

-- CHECK constraint: delivery_mode must be ASAP or SCHEDULED
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_delivery_mode_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_delivery_mode_check
      CHECK (delivery_mode IN ('ASAP', 'SCHEDULED'));
  END IF;
END $$;

-- Index: filter scheduled orders efficiently (dashboard + admin queries)
CREATE INDEX IF NOT EXISTS idx_orders_delivery_mode
  ON orders (delivery_mode)
  WHERE delivery_mode = 'SCHEDULED';

-- Index: sort/filter by scheduled slot start
CREATE INDEX IF NOT EXISTS idx_orders_scheduled_slot_start
  ON orders (scheduled_slot_start)
  WHERE scheduled_slot_start IS NOT NULL;
