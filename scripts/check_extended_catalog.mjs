import 'dotenv/config'

import { getClient } from '../src/config/database.js'
import { EXTENDED_CATEGORIES, EXTENDED_PRODUCTS, ORDER_PREFIX } from './extended_catalog_data.mjs'

async function main() {
  const client = await getClient()

  try {
    const categorySlugs = EXTENDED_CATEGORIES.map((category) => category.slug)
    const productSlugs = EXTENDED_PRODUCTS.map((product) => product.slug)

    const [
      totalsResult,
      categoriesResult,
      productsResult,
      coverageResult,
      activityResult,
      tagsResult,
      sampleResult,
    ] = await Promise.all([
      client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM categories) AS total_categories,
           (SELECT COUNT(*)::int FROM products) AS total_products`
      ),
      client.query(
        `SELECT COUNT(*)::int AS category_count
         FROM categories
         WHERE slug = ANY($1::text[])`,
        [categorySlugs]
      ),
      client.query(
        `SELECT COUNT(*)::int AS product_count
         FROM products
         WHERE slug = ANY($1::text[])`,
        [productSlugs]
      ),
      client.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(description), ''), NULL) IS NOT NULL)::int AS with_description,
           COUNT(*) FILTER (WHERE highlights IS NOT NULL AND highlights <> '{}'::jsonb)::int AS with_highlights,
           COUNT(*) FILTER (WHERE attributes IS NOT NULL AND attributes <> '[]'::jsonb)::int AS with_attributes,
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(vendor_name), ''), NULL) IS NOT NULL)::int AS with_vendor_name,
           COUNT(*) FILTER (WHERE COALESCE(NULLIF(TRIM(vendor_address), ''), NULL) IS NOT NULL)::int AS with_vendor_address,
           COUNT(*) FILTER (WHERE thumbnail_url IS NULL)::int AS with_null_thumbnail,
           COUNT(*) FILTER (WHERE images IS NULL OR images = '[]'::jsonb)::int AS with_empty_images
         FROM products
         WHERE slug = ANY($1::text[])`,
        [productSlugs]
      ),
      client.query(
        `SELECT
           COUNT(DISTINCT o.id)::int AS orders_count,
           COUNT(r.id)::int AS reviews_count
         FROM orders o
         LEFT JOIN reviews r ON r.order_id = o.id
         WHERE o.order_number LIKE $1`,
        [`${ORDER_PREFIX}%`]
      ),
      client.query(
        `SELECT
           COUNT(*) FILTER (WHERE tags @> ARRAY['super-mall']::text[])::int AS super_mall,
           COUNT(*) FILTER (WHERE tags @> ARRAY['half-price-store']::text[])::int AS half_price_store,
           COUNT(*) FILTER (WHERE tags @> ARRAY['cafe']::text[])::int AS cafe,
           COUNT(*) FILTER (WHERE tags @> ARRAY['dhaba']::text[])::int AS dhaba,
           COUNT(*) FILTER (WHERE tags @> ARRAY['electronics']::text[])::int AS electronics,
           COUNT(*) FILTER (WHERE tags @> ARRAY['fashion']::text[])::int AS fashion,
           COUNT(*) FILTER (WHERE tags @> ARRAY['featured-launch']::text[])::int AS featured_launch
         FROM products
         WHERE slug = ANY($1::text[])`,
        [productSlugs]
      ),
      client.query(
        `SELECT slug, name, brand, net_quantity, avg_rating, rating_count, vendor_name, tags
         FROM products
         WHERE slug = ANY($1::text[])
         ORDER BY slug
         LIMIT 6`,
        [productSlugs]
      ),
    ])

    console.log(
      JSON.stringify(
        {
          totals: totalsResult.rows[0],
          newCategories: categoriesResult.rows[0].category_count,
          newProducts: productsResult.rows[0].product_count,
          coverage: coverageResult.rows[0],
          activity: activityResult.rows[0],
          tags: tagsResult.rows[0],
          sampleProducts: sampleResult.rows,
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error('Extended catalog check failed:')
    console.error(error?.stack || error?.message || error)
    process.exitCode = 1
  } finally {
    client.release()
  }
}

main()
