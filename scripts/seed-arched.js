import 'dotenv/config'
import { query } from '../src/config/database.js'

console.log('\n🏗️  Adding arched_product_showcase to off_zone...\n')

// Find off_zone 'all' tab
const { rows: tabs } = await query(
  "SELECT id FROM theme_tabs WHERE store_key = 'off_zone' AND key = 'all' LIMIT 1"
)

if (tabs.length === 0) {
  console.log('❌ No off_zone all tab found!')
  process.exit(1)
}

const tabId = tabs[0].id
console.log(`  Found tab id: ${tabId}`)

// Check existing sections
const { rows: existing } = await query(
  "SELECT id, section_type, sort_order FROM section_manifests WHERE tab_id = $1 ORDER BY sort_order",
  [tabId]
)
console.log(`  Existing sections: ${existing.length}`)
existing.forEach(s => console.log(`    [${s.sort_order}] ${s.section_type}`))

// Remove any old arched sections
await query(
  "DELETE FROM section_manifests WHERE tab_id = $1 AND section_type = 'arched_product_showcase'",
  [tabId]
)

const maxOrder = existing.reduce((max, s) => Math.max(max, s.sort_order), 0)

const { rows: [created] } = await query(
  `INSERT INTO section_manifests (tab_id, section_type, sort_order, visible, config, merch_binding)
   VALUES ($1, 'arched_product_showcase', $2, true, $3::jsonb, '{}'::jsonb)
   RETURNING id, section_type, sort_order`,
  [tabId, maxOrder + 1, JSON.stringify({
    container_color: '#FDE7C4',
    title: 'Top Picks',
    arch_height: 14,
    corner_radius: 24,
  })]
)

console.log(`\n  ✅ Created: ${created.section_type} (id: ${created.id}, order: ${created.sort_order})`)

// Verify via public API query
const { rows: final } = await query(
  "SELECT section_type, sort_order FROM section_manifests WHERE tab_id = $1 ORDER BY sort_order",
  [tabId]
)
console.log(`\n  Final sections (${final.length}):`)
final.forEach(s => console.log(`    [${s.sort_order}] ${s.section_type}`))

console.log('\n🏁  Done!')
process.exit(0)
