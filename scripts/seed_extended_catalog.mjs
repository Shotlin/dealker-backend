import 'dotenv/config'

import { v4 as uuidv4 } from 'uuid'

import { getClient } from '../src/config/database.js'
import { cacheDeletePattern } from '../src/utils/cache.js'
import { EXTENDED_CATEGORIES, EXTENDED_PRODUCTS, ORDER_PREFIX, VENDORS } from './extended_catalog_data.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
let ADMIN_USER_ID = null

const DEMO_CUSTOMERS = [
  {
    id: 'a30809ea-5c4c-41b2-ba63-e970ff7b0a32',
    name: 'Aarav Mehta',
    phone: '9775845587',
  },
  {
    id: '0d2ad17e-7ea6-4a31-baa2-573fa03d2ded',
    name: 'Neha Sharma',
    phone: '6297831930',
  },
  {
    id: '99cde747-c299-4e71-916a-21ee60f36f16',
    name: 'Rohan Das',
    phone: '8436660424',
  },
  {
    id: '3fbc4c74-8526-4003-9f00-48a3538b7637',
    name: 'Priya Nair',
    phone: '9999999999',
  },
]

async function ensureDemoCustomers(client) {
  for (const customer of DEMO_CUSTOMERS) {
    await client.query(
      `INSERT INTO users (id, phone, name, role, is_active)
       VALUES ($1, $2, $3, 'CUSTOMER', true)
       ON CONFLICT (id) DO UPDATE
       SET phone = EXCLUDED.phone,
           name = EXCLUDED.name,
           role = 'CUSTOMER',
           is_active = true,
           updated_at = NOW()`,
      [customer.id, customer.phone, customer.name],
    )
  }
}

function normalizeSentence(value) {
  return String(value ?? '').replace(/\.$/, '').trim()
}

function lowerFirst(value) {
  const normalized = normalizeSentence(value)
  if (!normalized) return ''
  return normalized.charAt(0).toLowerCase() + normalized.slice(1)
}

function buildHighlights(product) {
  if (product.profile === 'tech') {
    return {
      'Product Type': product.productType,
      Model: product.model,
      [product.variantLabel]: product.variant,
      'Recommended Use': product.bestFor,
    }
  }

  if (product.profile === 'fashion') {
    return {
      'Product Type': product.productType,
      Material: product.material,
      Fit: product.fit,
      'Recommended Use': product.bestFor,
    }
  }

  return {
    'Product Type': product.productType,
    'Pack Size': product.netQuantity,
    [product.variantLabel]: product.variant,
    'Recommended Use': product.bestFor,
  }
}

function buildAttributes(product) {
  if (product.profile === 'tech') {
    return [
      { label: 'Brand', value: product.brand },
      { label: 'Product Type', value: product.productType },
      { label: 'Model', value: product.model },
      { label: product.variantLabel, value: product.variant },
      { label: product.specLabel, value: product.specValue },
      { label: 'Pack Type', value: product.packType },
      { label: 'Storage', value: product.storageInstructions },
      { label: 'Recommended Use', value: product.bestFor },
    ]
  }

  if (product.profile === 'fashion') {
    return [
      { label: 'Brand', value: product.brand },
      { label: 'Product Type', value: product.productType },
      { label: 'Net Quantity', value: product.netQuantity },
      { label: 'Material', value: product.material },
      { label: 'Fit', value: product.fit },
      { label: 'Pack Type', value: product.packType },
      { label: 'Care', value: product.careInstructions },
      { label: 'Recommended Use', value: product.bestFor },
    ]
  }

  return [
    { label: 'Brand', value: product.brand },
    { label: 'Product Type', value: product.productType },
    { label: 'Net Quantity', value: product.netQuantity },
    { label: product.variantLabel, value: product.variant },
    { label: 'Pack Type', value: product.packType },
    { label: 'Shelf Life', value: product.shelfLife },
    { label: 'Storage', value: product.storageInstructions },
    { label: 'Recommended Use', value: product.bestFor },
  ]
}

function buildDescription(product) {
  if (product.profile === 'tech') {
    return `${product.name} is designed for ${lowerFirst(product.bestFor)}. ${product.variantLabel}: ${product.variant}. ${product.specLabel}: ${product.specValue}. ${normalizeSentence(product.storageInstructions)}.`
  }

  if (product.profile === 'fashion') {
    return `${product.name} is designed for ${lowerFirst(product.bestFor)}. Material: ${product.material}. Fit: ${product.fit}. ${normalizeSentence(product.careInstructions)}.`
  }

  return `${product.name} is prepared for ${lowerFirst(product.bestFor)}. ${product.variantLabel}: ${product.variant}. ${normalizeSentence(product.storageInstructions)}.`
}

function buildReviewComments(product) {
  return [
    `${product.reviewLead}. Packaging and delivery experience felt reliable.`,
    `${product.reviewLead}. Product details matched what was shown in the app.`,
    `${product.reviewLead}. Worth reordering for the convenience and overall value.`,
  ].slice(0, product.seedReviewCount ?? 2)
}

function buildReviewRatings(product) {
  if (product.avgRating >= 4.6) return [5, 5, 4]
  if (product.avgRating >= 4.4) return [5, 4, 4]
  if (product.avgRating >= 4.2) return [4, 4, 5]
  return [4, 4, 4]
}

function buildSku(index, product) {
  const brandCode = product.brand.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4).padEnd(4, 'X')
  return `${brandCode}-${String(index + 1).padStart(3, '0')}-${product.slug.replace(/-/g, '').slice(0, 8).toUpperCase()}`
}

function buildBarcode(index) {
  return `8912600${String(100000 + index).slice(-6)}`
}

function buildCostPrice(price, salePrice) {
  const effectivePrice = Number(salePrice || price || 0)
  return Number((effectivePrice * 0.76).toFixed(2))
}

function buildMetaTitle(product) {
  return `${product.name} | ${product.brand} | Bakaloo`
}

function buildMetaDescription(product) {
  return `${product.brand} ${product.productType}, ${product.netQuantity}. Suitable for ${product.bestFor.toLowerCase()}.`
}

function buildAddress(index, customer) {
  return {
    name: customer.name,
    phone: customer.phone,
    line1: `${18 + index} Market Residency`,
    line2: 'Near Metro Station',
    landmark: 'Opposite Community Park',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560095',
    label: 'home',
  }
}

function buildOrderTimestamps(index, variantIndex) {
  const baseTime = Date.now() - (index + 7) * DAY_MS - variantIndex * 3 * 60 * 60 * 1000
  const createdAt = new Date(baseTime)
  const confirmedAt = new Date(baseTime + 10 * 60 * 1000)
  const outForDeliveryAt = new Date(baseTime + 85 * 60 * 1000)
  const deliveredAt = new Date(baseTime + 125 * 60 * 1000)
  const estimatedDelivery = new Date(baseTime + 130 * 60 * 1000)

  return { createdAt, confirmedAt, outForDeliveryAt, deliveredAt, estimatedDelivery }
}

function paymentMethodFor(index) {
  return ['UPI', 'CARD', 'COD', 'ONLINE'][index % 4]
}

function buildOrderNumber(index, variantIndex, slug) {
  const slugPart = slug.replace(/-/g, '').toUpperCase().slice(0, 8)
  return `${ORDER_PREFIX}${String(index + 1).padStart(2, '0')}${variantIndex + 1}${slugPart}`.slice(0, 20)
}

async function upsertCategories(client) {
  for (const category of EXTENDED_CATEGORIES) {
    await client.query(
      `INSERT INTO categories (name, slug, description, image_url, parent_id, sort_order, is_active)
       VALUES ($1,$2,$3,NULL,NULL,$4,true)
       ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           sort_order = EXCLUDED.sort_order,
           is_active = true,
           updated_at = NOW()`,
      [category.name, category.slug, category.description, category.sortOrder]
    )
  }

  const { rows } = await client.query(
    `SELECT id, slug
     FROM categories
     WHERE slug = ANY($1::text[])`,
    [EXTENDED_CATEGORIES.map((category) => category.slug)]
  )

  return new Map(rows.map((row) => [row.slug, row.id]))
}

async function clearExistingExtendedDemoData(client) {
  const { rows } = await client.query(
    `SELECT id
     FROM orders
     WHERE order_number LIKE $1`,
    [`${ORDER_PREFIX}%`]
  )

  const orderIds = rows.map((row) => row.id)
  if (orderIds.length === 0) {
    return { deletedOrders: 0, deletedReviews: 0 }
  }

  const { rowCount: deletedReviews } = await client.query(
    'DELETE FROM reviews WHERE order_id = ANY($1::uuid[])',
    [orderIds]
  )
  await client.query('DELETE FROM order_status_history WHERE order_id = ANY($1::uuid[])', [orderIds])
  await client.query('DELETE FROM order_items WHERE order_id = ANY($1::uuid[])', [orderIds])
  await client.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orderIds])

  return { deletedOrders: orderIds.length, deletedReviews }
}

async function upsertProduct(client, product, categoryId, index) {
  const vendor = VENDORS[product.vendorKey]
  const highlights = buildHighlights(product)
  const attributes = buildAttributes(product)
  const description = buildDescription(product)
  const sku = buildSku(index, product)
  const barcode = buildBarcode(index)

  const { rows } = await client.query(
    `INSERT INTO products (
       name, slug, description, price, sale_price, cost_price, category_id, stock_quantity,
       unit, thumbnail_url, images, tags, is_active, is_featured, total_sold, sku, barcode,
       low_stock_threshold, max_order_qty, ingredients, allergen_info, shelf_life,
       storage_instructions, certifications, nutrition_info, meta_title, meta_description,
       brand, brand_logo_url, net_quantity, highlights, attributes, vendor_name,
       vendor_address, vendor_fssai, return_policy, avg_rating, rating_count, is_authentic
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10::jsonb,$11,true,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23::jsonb,$24,$25,$26,NULL,$27,$28::jsonb,$29::jsonb,$30,$31,$32,$33,$34,$35,true
     )
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       price = EXCLUDED.price,
       sale_price = EXCLUDED.sale_price,
       cost_price = EXCLUDED.cost_price,
       category_id = EXCLUDED.category_id,
       stock_quantity = EXCLUDED.stock_quantity,
       unit = EXCLUDED.unit,
       thumbnail_url = NULL,
       images = EXCLUDED.images,
       tags = EXCLUDED.tags,
       is_active = true,
       is_featured = EXCLUDED.is_featured,
       total_sold = EXCLUDED.total_sold,
       sku = EXCLUDED.sku,
       barcode = EXCLUDED.barcode,
       low_stock_threshold = EXCLUDED.low_stock_threshold,
       max_order_qty = EXCLUDED.max_order_qty,
       ingredients = EXCLUDED.ingredients,
       allergen_info = EXCLUDED.allergen_info,
       shelf_life = EXCLUDED.shelf_life,
       storage_instructions = EXCLUDED.storage_instructions,
       certifications = EXCLUDED.certifications,
       nutrition_info = EXCLUDED.nutrition_info,
       meta_title = EXCLUDED.meta_title,
       meta_description = EXCLUDED.meta_description,
       brand = EXCLUDED.brand,
       brand_logo_url = NULL,
       net_quantity = EXCLUDED.net_quantity,
       highlights = EXCLUDED.highlights,
       attributes = EXCLUDED.attributes,
       vendor_name = EXCLUDED.vendor_name,
       vendor_address = EXCLUDED.vendor_address,
       vendor_fssai = EXCLUDED.vendor_fssai,
       return_policy = EXCLUDED.return_policy,
       avg_rating = EXCLUDED.avg_rating,
       rating_count = EXCLUDED.rating_count,
       is_authentic = true,
       updated_at = NOW()
     RETURNING id`,
    [
      product.name,
      product.slug,
      description,
      product.price,
      product.salePrice || null,
      buildCostPrice(product.price, product.salePrice),
      categoryId,
      product.stockQuantity ?? 0,
      product.unit || 'piece',
      JSON.stringify([]),
      product.tags || [],
      product.isFeatured || false,
      product.totalSold || 0,
      sku,
      barcode,
      10,
      product.maxOrderQty || null,
      product.ingredients || null,
      product.allergenInfo || null,
      product.shelfLife || null,
      product.storageInstructions || null,
      product.certifications || null,
      product.nutritionInfo ? JSON.stringify(product.nutritionInfo) : null,
      buildMetaTitle(product),
      buildMetaDescription(product),
      product.brand,
      product.netQuantity || null,
      JSON.stringify(highlights),
      JSON.stringify(attributes),
      vendor.name,
      vendor.address,
      vendor.fssai,
      product.returnPolicy || 'no_return',
      product.avgRating || 0,
      product.ratingCount || 0,
    ]
  )

  return rows[0].id
}

async function createDemoOrder(client, productRow, product, index, variantIndex) {
  const customer = DEMO_CUSTOMERS[(index + variantIndex) % DEMO_CUSTOMERS.length]
  const quantity = Math.min(variantIndex + 1, product.maxOrderQty || 2)
  const unitPrice = Number(product.salePrice || product.price)
  const subtotal = unitPrice * quantity
  const discountAmount = Math.max(0, (Number(product.price) - unitPrice) * quantity)
  const deliveryFee = product.profile === 'food' ? 25 : 35
  const platformFee = product.profile === 'food' ? 6 : 12
  const totalAmount = subtotal + deliveryFee + platformFee
  const times = buildOrderTimestamps(index, variantIndex)
  const orderNumber = buildOrderNumber(index, variantIndex, product.slug)
  const items = [
    {
      productId: productRow.id,
      name: product.name,
      price: unitPrice,
      quantity,
      unit: productRow.unit,
      total: subtotal,
    },
  ]

  const { rows } = await client.query(
    `INSERT INTO orders (
       order_number, customer_id, status, items, subtotal, discount_amount,
       delivery_fee, platform_fee, tax_amount, total_payable, payment_method,
       payment_status, coupon_code, delivery_address, delivery_notes,
       estimated_delivery, delivered_at, created_at, updated_at
     ) VALUES (
       $1,$2,'DELIVERED',$3::jsonb,$4,$5,$6,$7,0,$8,$9,'PAID',$10,$11::jsonb,$12,$13,$14,$15,$15
     )
     RETURNING id`,
    [
      orderNumber,
      customer.id,
      JSON.stringify(items),
      subtotal,
      discountAmount,
      deliveryFee,
      platformFee,
      totalAmount,
      paymentMethodFor(index + variantIndex),
      null,
      JSON.stringify(buildAddress(index + variantIndex, customer)),
      'Extended catalog demo order generated for merchandising validation.',
      times.estimatedDelivery,
      times.deliveredAt,
      times.createdAt,
    ]
  )

  const orderId = rows[0].id

  await client.query(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, unit, subtotal, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [orderId, productRow.id, product.name, unitPrice, quantity, productRow.unit, subtotal, times.createdAt]
  )

  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note, changed_at)
     VALUES
       ($1, NULL, 'PENDING', $2, 'Order created for extended catalog demo', $3),
       ($1, 'PENDING', 'CONFIRMED', $2, 'Order confirmed by store', $4),
       ($1, 'CONFIRMED', 'OUT_FOR_DELIVERY', $2, 'Packed and assigned for delivery', $5),
       ($1, 'OUT_FOR_DELIVERY', 'DELIVERED', $2, 'Delivered successfully', $6)`,
    [
      orderId,
      ADMIN_USER_ID,
      times.createdAt,
      times.confirmedAt,
      times.outForDeliveryAt,
      times.deliveredAt,
    ]
  )

  return {
    orderId,
    customerId: customer.id,
    createdAt: times.deliveredAt,
  }
}

async function createReview(client, productId, orderInfo, product, reviewIndex) {
  const comments = buildReviewComments(product)
  const ratings = buildReviewRatings(product)

  await client.query(
    `INSERT INTO reviews (
       user_id, product_id, order_id, rating, comment, is_verified_purchase, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,true,$6,$6)`,
    [
      orderInfo.customerId,
      productId,
      orderInfo.orderId,
      ratings[reviewIndex % ratings.length],
      comments[reviewIndex % comments.length],
      orderInfo.createdAt,
    ]
  )
}

async function seedOrdersAndReviewsForProduct(client, productRow, product, index) {
  let orders = 0
  let reviews = 0
  const iterations = product.seedReviewCount ?? 2

  for (let reviewIndex = 0; reviewIndex < iterations; reviewIndex += 1) {
    const orderInfo = await createDemoOrder(client, productRow, product, index, reviewIndex)
    orders += 1
    await createReview(client, productRow.id, orderInfo, product, reviewIndex)
    reviews += 1
  }

  return { orders, reviews }
}

async function main() {
  const client = await getClient()

  try {
    await client.query('BEGIN')

    const { rows: adminRows } = await client.query(
      `SELECT id FROM users
       WHERE role = 'ADMIN' AND is_active = true
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    if (!adminRows[0]) throw new Error('No active ADMIN user found — run the local account seed first.')
    ADMIN_USER_ID = adminRows[0].id

    await ensureDemoCustomers(client)

    const cleanupSummary = await clearExistingExtendedDemoData(client)
    const categoryIdBySlug = await upsertCategories(client)

    let productsUpserted = 0
    let ordersInserted = 0
    let reviewsInserted = 0

    for (const [index, product] of EXTENDED_PRODUCTS.entries()) {
      const categoryId = categoryIdBySlug.get(product.categorySlug)
      if (!categoryId) {
        throw new Error(`Missing category for slug ${product.categorySlug}`)
      }

      const productId = await upsertProduct(client, product, categoryId, index)
      productsUpserted += 1

      const seeded = await seedOrdersAndReviewsForProduct(client, { id: productId, unit: product.unit }, product, index)
      ordersInserted += seeded.orders
      reviewsInserted += seeded.reviews
    }

    await client.query('COMMIT')

    await cacheDeletePattern('products:*')
    await cacheDeletePattern('categories:*')

    console.log(
      JSON.stringify(
        {
          categoriesUpserted: EXTENDED_CATEGORIES.length,
          productsUpserted,
          ordersInserted,
          reviewsInserted,
          cleanupSummary,
        },
        null,
        2
      )
    )
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Extended catalog seed failed:')
    console.error(error?.stack || error?.message || error)
    process.exitCode = 1
  } finally {
    client.release()
  }
}

main()
