-- Sell-your-phone: pickup is booked automatically (Shiprocket reverse pickup, customer home -> vendor store) once the buyer has paid.
ALTER TABLE sell_pickups ADD COLUMN IF NOT EXISTS is_simulated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sell_pickups ADD COLUMN IF NOT EXISTS auto_booked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sell_pickups ADD COLUMN IF NOT EXISTS provider_shipment_id VARCHAR(40);
