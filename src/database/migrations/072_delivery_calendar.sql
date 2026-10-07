-- Migration 072: Delivery calendar (single global schedule) — replaces the
-- hardcoded 7-day/fixed-window generator in orders/delivery-slots.routes.js
-- with a real admin-managed calendar. Two-tier model: a recurring weekly
-- template (admin edits once) generates materialized concrete days/slots
-- (what customers actually book against), which the admin can also
-- override for a single date without touching the template.

CREATE TABLE IF NOT EXISTS delivery_calendar_weekly_template (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  weekday       SMALLINT NOT NULL,
  is_available  BOOLEAN NOT NULL DEFAULT true,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  label         VARCHAR(60) NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_dcwt_weekday'
  ) THEN
    ALTER TABLE delivery_calendar_weekly_template ADD CONSTRAINT chk_dcwt_weekday
      CHECK (weekday BETWEEN 0 AND 6);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_dcwt_time_range'
  ) THEN
    ALTER TABLE delivery_calendar_weekly_template ADD CONSTRAINT chk_dcwt_time_range
      CHECK (end_time > start_time);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS delivery_calendar_days (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  calendar_date DATE NOT NULL,
  is_available  BOOLEAN NOT NULL DEFAULT true,
  note          TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by    UUID NULL REFERENCES users(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_dcd_calendar_date'
  ) THEN
    ALTER TABLE delivery_calendar_days ADD CONSTRAINT uq_dcd_calendar_date UNIQUE (calendar_date);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS delivery_calendar_slots (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  calendar_day_id UUID NOT NULL REFERENCES delivery_calendar_days(id) ON DELETE CASCADE,
  start_time      TIME NOT NULL,
  end_time        TIME NOT NULL,
  label           VARCHAR(60) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  display_order   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_dcs_time_range'
  ) THEN
    ALTER TABLE delivery_calendar_slots ADD CONSTRAINT chk_dcs_time_range
      CHECK (end_time > start_time);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dcs_calendar_day ON delivery_calendar_slots (calendar_day_id);
CREATE INDEX IF NOT EXISTS idx_dcd_calendar_date ON delivery_calendar_days (calendar_date);

-- orders: optional link to the calendar slot the customer booked (informational
-- — scheduled_slot_start/end/label on orders remain the source of truth for
-- actual delivery logistics, same as before this migration).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'delivery_calendar_slot_id'
  ) THEN
    ALTER TABLE orders ADD COLUMN delivery_calendar_slot_id UUID NULL
      REFERENCES delivery_calendar_slots(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Seed a default weekly template matching the exact fixed windows the old
-- hardcoded generator (orders/delivery-slots.routes.js) used — 7 windows/day,
-- every day available. Without this, the delivery-slot picker would go
-- empty for every existing customer the moment this migration lands, until
-- an admin manually configures Store Hours — a real regression. Only seeds
-- when the table is completely empty, so it never clobbers an admin's
-- real edits on a second run.
INSERT INTO delivery_calendar_weekly_template (weekday, is_available, start_time, end_time, label, display_order)
SELECT weekday, true, w.start_time, w.end_time, w.label, w.display_order
FROM generate_series(0, 6) AS weekday
CROSS JOIN (VALUES
  ('07:00'::time, '09:00'::time, '7:00 AM – 9:00 AM',   0),
  ('09:00'::time, '11:00'::time, '9:00 AM – 11:00 AM',  1),
  ('11:00'::time, '13:00'::time, '11:00 AM – 1:00 PM',  2),
  ('13:00'::time, '15:00'::time, '1:00 PM – 3:00 PM',   3),
  ('15:00'::time, '17:00'::time, '3:00 PM – 5:00 PM',   4),
  ('17:00'::time, '19:00'::time, '5:00 PM – 7:00 PM',   5),
  ('19:00'::time, '21:00'::time, '7:00 PM – 9:00 PM',   6)
) AS w(start_time, end_time, label, display_order)
WHERE NOT EXISTS (SELECT 1 FROM delivery_calendar_weekly_template);
