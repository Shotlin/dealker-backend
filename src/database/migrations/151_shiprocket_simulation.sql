-- 151_shiprocket_simulation.sql
-- Demo mode: no real Shiprocket calls; shipments are marked so pollers/cancel skip the real API.
ALTER TABLE shiprocket_settings ADD COLUMN IF NOT EXISTS simulation_mode BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE shiprocket_shipments ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE;
