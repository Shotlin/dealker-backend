-- Where a model's catalogue price came from: 'sheet' (market price sheet), 'estimate' (generated, to be reviewed), 'admin' (edited by staff - never overwritten by the seeder).
ALTER TABLE sell_device_models ADD COLUMN IF NOT EXISTS price_source TEXT;
