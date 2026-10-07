export async function up(client) {
  await client.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS brand VARCHAR(200);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_logo_url TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS net_quantity VARCHAR(200);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS highlights JSONB DEFAULT '{}';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS attributes JSONB DEFAULT '[]';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(200);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_address TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_fssai VARCHAR(50);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS return_policy VARCHAR(50) DEFAULT 'no_return';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS avg_rating DECIMAL(2,1) DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_count INTEGER DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS is_authentic BOOLEAN DEFAULT true;
  `)
}

export async function down(client) {
  await client.query(`
    ALTER TABLE products
      DROP COLUMN IF EXISTS brand,
      DROP COLUMN IF EXISTS brand_logo_url,
      DROP COLUMN IF EXISTS net_quantity,
      DROP COLUMN IF EXISTS highlights,
      DROP COLUMN IF EXISTS attributes,
      DROP COLUMN IF EXISTS vendor_name,
      DROP COLUMN IF EXISTS vendor_address,
      DROP COLUMN IF EXISTS vendor_fssai,
      DROP COLUMN IF EXISTS return_policy,
      DROP COLUMN IF EXISTS avg_rating,
      DROP COLUMN IF EXISTS rating_count,
      DROP COLUMN IF EXISTS is_authentic;
  `)
}
