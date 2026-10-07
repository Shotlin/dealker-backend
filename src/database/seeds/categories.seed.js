import { v4 as uuidv4 } from 'uuid'

export const categories = [
  { id: uuidv4(), name: 'Fruits & Vegetables', slug: 'fruits-vegetables', description: 'Fresh fruits and vegetables delivered daily', sort_order: 1 },
  { id: uuidv4(), name: 'Dairy & Eggs', slug: 'dairy-eggs', description: 'Milk, cheese, butter, eggs and more', sort_order: 2 },
  { id: uuidv4(), name: 'Bakery & Bread', slug: 'bakery-bread', description: 'Fresh bread, cakes and bakery items', sort_order: 3 },
  { id: uuidv4(), name: 'Beverages', slug: 'beverages', description: 'Juices, soft drinks, tea, coffee', sort_order: 4 },
  { id: uuidv4(), name: 'Snacks & Chips', slug: 'snacks-chips', description: 'Chips, namkeen, biscuits and more', sort_order: 5 },
  { id: uuidv4(), name: 'Rice & Grains', slug: 'rice-grains', description: 'Rice, wheat, dal, pulses', sort_order: 6 },
  { id: uuidv4(), name: 'Cooking Oils', slug: 'cooking-oils', description: 'Refined oil, mustard oil, ghee', sort_order: 7 },
  { id: uuidv4(), name: 'Masala & Spices', slug: 'masala-spices', description: 'Indian spices and masala powders', sort_order: 8 },
  { id: uuidv4(), name: 'Frozen Food', slug: 'frozen-food', description: 'Frozen meals, ice cream, frozen veggies', sort_order: 9 },
  { id: uuidv4(), name: 'Personal Care', slug: 'personal-care', description: 'Soaps, shampoo, skincare essentials', sort_order: 10 },
  { id: uuidv4(), name: 'Household', slug: 'household', description: 'Cleaning supplies, detergent, essentials', sort_order: 11 },
  { id: uuidv4(), name: 'Baby Care', slug: 'baby-care', description: 'Diapers, baby food, accessories', sort_order: 12 },
]

/**
 * Seed categories into the database
 * @param {import('pg').Pool} pool
 */
export async function seedCategories(pool) {
  console.log('🌱 Seeding categories...')

  for (const cat of categories) {
    await pool.query(
      `INSERT INTO categories (id, name, slug, description, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (slug) DO NOTHING`,
      [cat.id, cat.name, cat.slug, cat.description, cat.sort_order]
    )
  }

  console.log(`  ✅ ${categories.length} categories seeded`)
  return categories
}
