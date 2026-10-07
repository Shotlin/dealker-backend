import 'dotenv/config'

import { query } from '../src/config/database.js'

const FIELD_CHECKS = [
  {
    key: 'brand',
    label: 'brand',
    hasValue: (product) => isNonEmptyString(product.brand),
  },
  {
    key: 'net_quantity',
    label: 'net_quantity',
    hasValue: (product) => isNonEmptyString(product.net_quantity),
  },
  {
    key: 'highlights',
    label: 'highlights',
    hasValue: (product) => isNonEmptyObject(product.highlights),
  },
  {
    key: 'attributes',
    label: 'attributes',
    hasValue: (product) => isNonEmptyArray(product.attributes),
  },
  {
    key: 'nutrition_info',
    label: 'nutrition_info',
    hasValue: (product) => isNonEmptyObject(product.nutrition_info),
  },
  {
    key: 'vendor_name',
    label: 'vendor_name',
    hasValue: (product) => isNonEmptyString(product.vendor_name),
  },
  {
    key: 'avg_rating',
    label: 'avg_rating',
    hasValue: (product) => Number(product.avg_rating || 0) > 0,
  },
  {
    key: 'rating_count',
    label: 'rating_count',
    hasValue: (product) => Number(product.rating_count || 0) > 0,
  },
  {
    key: 'reviews',
    label: 'reviews count',
    hasValue: (product) => Number(product.reviews_count || 0) > 0,
  },
  {
    key: 'orders',
    label: 'order count',
    hasValue: (product) => Number(product.orders_count || 0) > 0,
  },
]

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isNonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0
}

function isNonEmptyObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0
}

function formatPercent(part, total) {
  if (!total) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : JSON.stringify(value)
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length === 0 ? '{}' : JSON.stringify(value)
  }
  return String(value ?? '')
}

async function main() {
  const { rows } = await query(
    `SELECT
       p.id,
       p.name,
       p.brand,
       p.net_quantity,
       p.highlights,
       p.attributes,
       p.nutrition_info,
       p.vendor_name,
       p.avg_rating,
       p.rating_count,
       COALESCE(rev.review_count, 0)::int AS reviews_count,
       COALESCE(ord.order_count, 0)::int AS orders_count
     FROM products p
     LEFT JOIN (
       SELECT product_id, COUNT(*)::int AS review_count
       FROM reviews
       GROUP BY product_id
     ) rev ON rev.product_id = p.id
     LEFT JOIN (
       SELECT oi.product_id, COUNT(DISTINCT oi.order_id)::int AS order_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.status <> 'CANCELLED'
       GROUP BY oi.product_id
     ) ord ON ord.product_id = p.id
     ORDER BY p.name ASC`
  )

  const totalProducts = rows.length
  const fieldStats = FIELD_CHECKS.map((field) => ({
    ...field,
    present: 0,
    missing: [],
  }))

  const completeProducts = []
  const incompleteProducts = []

  for (const product of rows) {
    const missingFields = []

    for (const stat of fieldStats) {
      if (stat.hasValue(product)) {
        stat.present += 1
      } else {
        missingFields.push(stat.label)
      }
    }

    const productSummary = {
      id: product.id,
      name: product.name,
      missingFields,
      brand: formatValue(product.brand),
      net_quantity: formatValue(product.net_quantity),
      highlights: formatValue(product.highlights),
      attributes: formatValue(product.attributes),
      nutrition_info: formatValue(product.nutrition_info),
      vendor_name: formatValue(product.vendor_name),
      avg_rating: Number(product.avg_rating || 0).toFixed(1),
      rating_count: Number(product.rating_count || 0),
      reviews_count: Number(product.reviews_count || 0),
      orders_count: Number(product.orders_count || 0),
    }

    if (missingFields.length === 0) {
      completeProducts.push(productSummary)
    } else {
      incompleteProducts.push(productSummary)
      for (const field of missingFields) {
        const stat = fieldStats.find((entry) => entry.label === field)
        if (stat) {
          stat.missing.push({ id: product.id, name: product.name })
        }
      }
    }
  }

  console.log(`\nDemo Product Completeness Report`)
  console.log(`Total products: ${totalProducts}`)
  console.log(`Complete products: ${completeProducts.length}`)
  console.log(`Incomplete products: ${incompleteProducts.length}`)

  console.log(`\nField coverage:`)
  for (const stat of fieldStats) {
    console.log(
      `- ${stat.label}: ${stat.present}/${totalProducts} (${formatPercent(stat.present, totalProducts)})`
    )
  }

  console.log(`\nProducts with all demo fields:`)
  if (completeProducts.length === 0) {
    console.log(`- none`)
  } else {
    for (const product of completeProducts) {
      console.log(`- ${product.name} (${product.id})`)
    }
  }

  console.log(`\nProducts missing one or more demo fields:`)
  if (incompleteProducts.length === 0) {
    console.log(`- none`)
  } else {
    for (const product of incompleteProducts) {
      console.log(`- ${product.name} (${product.id}) -> missing: ${product.missingFields.join(', ')}`)
    }
  }

  console.log(`\nPer-product details:`)
  for (const product of rows) {
    console.log(
      [
        `- ${product.name}`,
        `brand=${formatValue(product.brand)}`,
        `net_quantity=${formatValue(product.net_quantity)}`,
        `highlights=${formatValue(product.highlights)}`,
        `attributes=${formatValue(product.attributes)}`,
        `nutrition_info=${formatValue(product.nutrition_info)}`,
        `vendor_name=${formatValue(product.vendor_name)}`,
        `avg_rating=${Number(product.avg_rating || 0).toFixed(1)}`,
        `rating_count=${Number(product.rating_count || 0)}`,
        `reviews=${Number(product.reviews_count || 0)}`,
        `orders=${Number(product.orders_count || 0)}`,
      ].join(' | ')
    )
  }
}

main().catch((error) => {
  console.error('Demo completeness check failed:')
  console.error(error?.stack || error?.message || error)
  process.exitCode = 1
})
