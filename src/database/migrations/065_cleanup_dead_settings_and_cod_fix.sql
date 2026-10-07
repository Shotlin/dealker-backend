-- 065_cleanup_dead_settings_and_cod_fix.sql
--
-- Fixes two live bugs reported by the admin (2026-07-02):
--
-- 1. "Fee toggles don't take effect" — the dashboard's General Settings page
--    exposed app_settings keys (delivery_fee, free_delivery_above,
--    platform_fee, min_order_amount) that LOOK like fee config but are never
--    read by any order/cart calculation (TotalsEngine reads exclusively from
--    the `fee_settings` table — see migration 055). Saving these keys always
--    "succeeded" with zero real-world effect, which is exactly the symptom
--    reported. They are removed here so the confusing dead surface is gone;
--    the only live fee config is Settings → Fees (fee_settings table).
--
-- 2. "COD works backwards above ₹99" — cod_min_order_amount (minimum, added
--    in migration 057) and cod_max_amount (maximum, added in migration 014)
--    are two separate, correctly-implemented fields (see
--    bill-summary.service.js#_buildPaymentMethods). But cod_max_amount was
--    only ever surfaced on the same confusing dead General Settings page,
--    right next to an unrelated decoy field also called "Min Order Amount".
--    If an admin, looking for "the COD minimum", ended up setting
--    cod_max_amount to 99 instead, the effective window for COD becomes
--    `cod_min_order_amount <= total <= 99` — i.e. COD only works for an
--    order of exactly ₹99, so it looks "unavailable above ₹99". This
--    migration detects and repairs exactly that broken state (max <= min)
--    by resetting cod_max_amount to a sane, non-restrictive default; it does
--    NOT touch cod_max_amount if an admin has it validly set above the
--    minimum.

-- ─── Remove dead fee/limit keys never read by any calculation ──────────
DELETE FROM app_settings
 WHERE key IN ('delivery_fee', 'free_delivery_above', 'platform_fee', 'min_order_amount');

-- ─── Repair an inverted/collapsed COD min/max window ────────────────────
-- Only fires when max <= min (the broken state); a legitimately-configured
-- max above the min is left untouched.
UPDATE app_settings AS max_row
   SET value = '2000', updated_at = NOW()
  FROM app_settings AS min_row
 WHERE max_row.key = 'cod_max_amount'
   AND min_row.key = 'cod_min_order_amount'
   AND (max_row.value::text)::numeric <= (min_row.value::text)::numeric;

-- Ensure cod_max_amount always has an unambiguous description even if the
-- row predates this migration (originally seeded by 014_admin_polish.sql).
UPDATE app_settings
   SET description = 'Maximum bill amount (after fees) for Cash on Delivery to be offered. Leave high / unset for no cap.'
 WHERE key = 'cod_max_amount';
