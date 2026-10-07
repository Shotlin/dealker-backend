import { parse } from 'csv-parse'
import { getClient } from '../config/database.js'
import { generateSlug } from './slugify.js'
import { logger } from '../config/logger.js'

/**
 * Bulk-import products from CSV buffer
 *
 * Expected CSV columns:
 *   name, description, price, stock_quantity, unit, category_id,
 *   images (pipe-separated URLs), is_featured (true/false)
 *
 * Returns { imported, skipped, errors }
 */
export async function importProductsFromCSV(buffer) {
  const records = await new Promise((resolve, reject) => {
    parse(buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: true,
      cast_date: false,
    }, (err, data) => {
      if (err) return reject(err)
      resolve(data)
    })
  })

  if (records.length === 0) {
    return { imported: 0, skipped: 0, errors: ['CSV file is empty'] }
  }

  // Validate required columns
  const requiredColumns = ['name', 'price', 'stock_quantity', 'unit', 'category_id']
  const firstRow = records[0]
  const missing = requiredColumns.filter(c => !(c in firstRow))
  if (missing.length > 0) {
    return { imported: 0, skipped: 0, errors: [`Missing columns: ${missing.join(', ')}`] }
  }

  const client = await getClient()
  const errors = []
  let imported = 0
  let skipped = 0

  try {
    await client.query('BEGIN')

    for (let i = 0; i < records.length; i++) {
      const row = records[i]
      const rowNum = i + 2 // 1-based + header

      try {
        const name = String(row.name || '').trim()
        if (!name) {
          errors.push(`Row ${rowNum}: Missing name`)
          skipped++
          continue
        }

        const price = parseFloat(row.price)
        if (isNaN(price) || price < 0) {
          errors.push(`Row ${rowNum}: Invalid price`)
          skipped++
          continue
        }

        const stock = parseInt(row.stock_quantity, 10)
        if (isNaN(stock) || stock < 0) {
          errors.push(`Row ${rowNum}: Invalid stock_quantity`)
          skipped++
          continue
        }

        const images = row.images
          ? String(row.images).split('|').map(u => u.trim()).filter(Boolean)
          : []

        const isFeatured = String(row.is_featured || '').toLowerCase() === 'true'
        const slug = generateSlug(name)

        await client.query(
          `INSERT INTO products (
            name, slug, description, price, stock_quantity, unit,
            category_id, images, is_featured, is_active
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
          ON CONFLICT (slug) DO UPDATE SET
            price = EXCLUDED.price,
            stock_quantity = EXCLUDED.stock_quantity,
            description = EXCLUDED.description,
            updated_at = NOW()`,
          [
            name,
            slug,
            row.description || null,
            price,
            stock,
            row.unit || 'pc',
            row.category_id,
            JSON.stringify(images),
            isFeatured,
          ]
        )
        imported++
      } catch (rowErr) {
        errors.push(`Row ${rowNum}: ${rowErr.message}`)
        skipped++
      }
    }

    await client.query('COMMIT')
    logger.info({ imported, skipped }, 'CSV bulk import completed')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error({ err: err.message }, 'CSV import transaction failed')
    return { imported: 0, skipped: records.length, errors: [err.message] }
  } finally {
    client.release()
  }

  return { imported, skipped, errors }
}
