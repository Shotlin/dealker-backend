-- Units added automatically (default QC from the listing's own details) until the vendor inspects each device.
ALTER TABLE listing_units ADD COLUMN IF NOT EXISTS auto_filled BOOLEAN NOT NULL DEFAULT FALSE;
