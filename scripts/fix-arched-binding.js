import 'dotenv/config'
import { query } from '../src/config/database.js'

const { rows } = await query(
  `SELECT id, section_type, merch_binding FROM section_manifests WHERE section_type = 'arched_product_showcase'`
)
console.log('Arched sections:', JSON.stringify(rows, null, 2))
process.exit(0)
