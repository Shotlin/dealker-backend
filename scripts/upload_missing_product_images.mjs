import 'dotenv/config'

import fs from 'fs'
import path from 'path'

import { closePool, getClient } from '../src/config/database.js'
import { UploadsService } from '../src/modules/uploads/uploads.service.js'

const IMAGE_DIR = '/Users/sayanmondal/Downloads/new p'
const DRY_RUN = process.argv.includes('--dry-run')

const MANUAL_FILE_OVERRIDES = {
  'apple iphone 15': 'Apple iPhone 15 — 128GB',
  'motorola g85 5g': 'Motorola G85 5G — 8GB/128GB',
  'oneplus nord ce 4 lite': 'OnePlus Nord CE 4 Lite — 8GB/128GB',
  'poco x6 5g': 'POCO X6 5G — 8GB/256GB',
  'redmi note 13 5g': 'Redmi Note 13 5G — 6GB/128GB',
  'samsung galaxy a55 5g': 'Samsung Galaxy A55 5G — 8GB/128GB',
  'realme narzo 70 5g': 'realme Narzo 70 5G — 6GB/128GB',
  'nokia t10': 'Nokia T10 Tablet — 32GB Wi-Fi',
  'fire boltt ninja call pro plus': 'Fire-Boltt Ninja Call Pro Plus',
}

function stripExtension(filename) {
  return filename.replace(/\.[^.]+$/, '')
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[—–-]/g, ' ')
    .replace(/\b\d+\s*gb\/\d+\s*gb\b/g, ' ')
    .replace(/\b\d+\s*gb\b/g, ' ')
    .replace(/\b\d+\s*tb\b/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*l\b/g, ' ')
    .replace(/\b\d+\s*ml\b/g, ' ')
    .replace(/\b\d+\s*w\b/g, ' ')
    .replace(/\b\d+\s*in\s*\d+\b/g, ' ')
    .replace(/\bpack of \d+\b/g, ' ')
    .replace(/\b1m\b/g, ' 1m ')
    .replace(/\btablet\b/g, ' tablet ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeFileStem(filename) {
  return normalize(stripExtension(filename)).replace(/\b(\d)$/g, '').trim()
}

function buildProductKeys(product) {
  const keys = new Set()
  keys.add(normalize(product.name))
  keys.add(
    normalize(
      product.name
        .replace(/\s+[—-]\s+.*$/, '')
        .replace(/\s+\d+\s*gb\/\d+\s*gb$/i, '')
        .replace(/\s+\d+\s*gb$/i, '')
        .replace(/\s+\d+(\.\d+)?\s*l$/i, '')
        .replace(/\s+\d+\s*ml$/i, '')
        .replace(/\s+\d+\s*w$/i, '')
    )
  )
  return Array.from(keys).filter(Boolean)
}

function matchFileToProduct(filename, products) {
  const stem = normalizeFileStem(filename)
  const manualTarget = MANUAL_FILE_OVERRIDES[stem]

  if (manualTarget) {
    return products.find((product) => product.name === manualTarget) || null
  }

  const exactMatches = products.filter((product) => buildProductKeys(product).includes(stem))
  if (exactMatches.length === 1) {
    return exactMatches[0]
  }

  const containsMatches = products.filter((product) =>
    buildProductKeys(product).some((key) => key.includes(stem) || stem.includes(key))
  )

  if (containsMatches.length === 1) {
    return containsMatches[0]
  }

  return null
}

async function main() {
  const client = await getClient()
  const uploadsService = new UploadsService()

  try {
    const { rows: products } = await client.query(
      `SELECT id, name, slug, thumbnail_url, COALESCE(jsonb_array_length(images), 0) AS image_count
       FROM products
       WHERE thumbnail_url IS NULL
         AND COALESCE(jsonb_array_length(images), 0) = 0
       ORDER BY name`
    )

    const filenames = fs.readdirSync(IMAGE_DIR).filter((name) => !name.startsWith('.'))
    const matches = []
    const unmatchedFiles = []
    const usedProductIds = new Set()

    for (const filename of filenames) {
      const product = matchFileToProduct(filename, products)
      if (!product || usedProductIds.has(product.id)) {
        unmatchedFiles.push(filename)
        continue
      }

      usedProductIds.add(product.id)
      matches.push({
        filename,
        filePath: path.join(IMAGE_DIR, filename),
        product,
      })
    }

    if (DRY_RUN) {
      console.log(
        JSON.stringify(
          {
            dryRun: true,
            missingProducts: products.length,
            matchedCount: matches.length,
            matched: matches.map((item) => ({
              filename: item.filename,
              productName: item.product.name,
              slug: item.product.slug,
            })),
            unmatchedFiles,
            unmatchedProducts: products
              .filter((product) => !usedProductIds.has(product.id))
              .map((product) => product.name),
          },
          null,
          2
        )
      )
      return
    }

    const results = []

    for (const match of matches) {
      const stream = fs.createReadStream(match.filePath)
      const uploaded = await uploadsService.uploadImage(stream, {
        publicId: match.product.slug,
      })

      const { rows } = await client.query(
        `UPDATE products
         SET thumbnail_url = $1,
             images = $2::jsonb,
             updated_at = NOW()
         WHERE id = $3
           AND thumbnail_url IS NULL
           AND COALESCE(jsonb_array_length(images), 0) = 0
         RETURNING id, name, slug, thumbnail_url`,
        [uploaded.url, JSON.stringify([]), match.product.id]
      )

      if (rows[0]) {
        results.push({
          filename: match.filename,
          name: rows[0].name,
          slug: rows[0].slug,
          thumbnail_url: rows[0].thumbnail_url,
        })
      }
    }

    const { rows: remainingRows } = await client.query(
      `SELECT COUNT(*)::int AS remaining
       FROM products
       WHERE thumbnail_url IS NULL
         AND COALESCE(jsonb_array_length(images), 0) = 0`
    )

    console.log(
      JSON.stringify(
        {
          dryRun: false,
          matchedCount: matches.length,
          uploadedCount: results.length,
          unmatchedFiles,
          remainingMissingImages: remainingRows[0].remaining,
          uploaded: results,
        },
        null,
        2
      )
    )
  } finally {
    client.release()
    await closePool()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
