import { v4 as uuidv4 } from 'uuid'

/**
 * Seed products into the database
 * @param {import('pg').Pool} pool
 * @param {Array} categories - Seeded categories with IDs
 */
export async function seedProducts(pool, categories) {
  console.log('🌱 Seeding products...')

  const catMap = {}
  for (const c of categories) {
    catMap[c.slug] = c.id
  }

  const products = [
    // Fruits & Vegetables
    { name: 'Banana — Robusta', slug: 'banana-robusta', price: 45, unit: 'kg', stock: 200, category: 'fruits-vegetables', featured: true },
    { name: 'Onion', slug: 'onion', price: 35, unit: 'kg', stock: 300, category: 'fruits-vegetables' },
    { name: 'Tomato — Local', slug: 'tomato-local', price: 40, unit: 'kg', stock: 250, category: 'fruits-vegetables' },
    { name: 'Potato', slug: 'potato', price: 30, unit: 'kg', stock: 400, category: 'fruits-vegetables' },
    { name: 'Apple — Shimla', slug: 'apple-shimla', price: 180, unit: 'kg', stock: 100, category: 'fruits-vegetables', featured: true },
    { name: 'Spinach (Palak)', slug: 'spinach-palak', price: 25, unit: 'pack', stock: 150, category: 'fruits-vegetables' },

    // Dairy & Eggs
    { name: 'Amul Toned Milk — 500ml', slug: 'amul-toned-milk-500ml', price: 28, unit: 'pack', stock: 500, category: 'dairy-eggs', featured: true },
    { name: 'Amul Butter — 100g', slug: 'amul-butter-100g', price: 56, unit: 'piece', stock: 200, category: 'dairy-eggs' },
    { name: 'Farm Eggs — 6 Pack', slug: 'farm-eggs-6pack', price: 60, unit: 'pack', stock: 300, category: 'dairy-eggs' },
    { name: 'Paneer — 200g', slug: 'paneer-200g', price: 85, unit: 'piece', stock: 150, category: 'dairy-eggs' },

    // Bakery
    { name: 'Britannia White Bread', slug: 'britannia-white-bread', price: 40, unit: 'piece', stock: 200, category: 'bakery-bread' },
    { name: 'Multigrain Bread', slug: 'multigrain-bread', price: 55, unit: 'piece', stock: 100, category: 'bakery-bread' },

    // Beverages
    { name: 'Coca-Cola — 750ml', slug: 'coca-cola-750ml', price: 40, unit: 'piece', stock: 300, category: 'beverages' },
    { name: 'Tata Tea Gold — 500g', slug: 'tata-tea-gold-500g', price: 265, unit: 'piece', stock: 150, category: 'beverages', featured: true },
    { name: 'Nescafé Classic — 100g', slug: 'nescafe-classic-100g', price: 295, unit: 'piece', stock: 120, category: 'beverages' },
    { name: 'Real Mango Juice — 1L', slug: 'real-mango-juice-1l', price: 99, unit: 'piece', stock: 200, category: 'beverages' },

    // Snacks
    { name: "Lay's Classic Salted — 90g", slug: 'lays-classic-90g', price: 20, unit: 'piece', stock: 400, category: 'snacks-chips' },
    { name: 'Haldiram Aloo Bhujia — 200g', slug: 'haldiram-aloo-bhujia-200g', price: 60, unit: 'piece', stock: 250, category: 'snacks-chips' },
    { name: 'Parle-G Biscuits — 250g', slug: 'parle-g-250g', price: 22, unit: 'piece', stock: 500, category: 'snacks-chips' },

    // Rice & Grains
    { name: 'India Gate Basmati — 5kg', slug: 'india-gate-basmati-5kg', price: 525, unit: 'piece', stock: 100, category: 'rice-grains', featured: true },
    { name: 'Toor Dal — 1kg', slug: 'toor-dal-1kg', price: 160, unit: 'piece', stock: 200, category: 'rice-grains' },
    { name: 'Aashirvaad Atta — 5kg', slug: 'aashirvaad-atta-5kg', price: 300, unit: 'piece', stock: 150, category: 'rice-grains' },

    // Cooking Oils
    { name: 'Fortune Sunflower Oil — 1L', slug: 'fortune-sunflower-1l', price: 145, unit: 'piece', stock: 200, category: 'cooking-oils' },
    { name: 'Amul Ghee — 500ml', slug: 'amul-ghee-500ml', price: 290, unit: 'piece', stock: 120, category: 'cooking-oils' },

    // Masala & Spices
    { name: 'MDH Garam Masala — 100g', slug: 'mdh-garam-masala-100g', price: 72, unit: 'piece', stock: 300, category: 'masala-spices' },
    { name: 'Everest Turmeric — 100g', slug: 'everest-turmeric-100g', price: 45, unit: 'piece', stock: 350, category: 'masala-spices' },
    { name: 'Red Chilli Powder — 200g', slug: 'red-chilli-powder-200g', price: 65, unit: 'piece', stock: 250, category: 'masala-spices' },

    // Frozen Food
    { name: 'ITC Aashirvaad Paratha — 5 Pack', slug: 'itc-paratha-5pack', price: 90, unit: 'pack', stock: 100, category: 'frozen-food' },
    { name: 'Amul Ice Cream — Vanilla 1L', slug: 'amul-ice-cream-vanilla-1l', price: 220, unit: 'piece', stock: 80, category: 'frozen-food' },

    // Personal Care
    { name: 'Dove Soap — 100g', slug: 'dove-soap-100g', price: 55, unit: 'piece', stock: 400, category: 'personal-care' },
    { name: 'Head & Shoulders Shampoo — 340ml', slug: 'head-shoulders-340ml', price: 330, unit: 'piece', stock: 150, category: 'personal-care' },

    // Household
    { name: 'Surf Excel Easy Wash — 1.5kg', slug: 'surf-excel-1-5kg', price: 215, unit: 'piece', stock: 200, category: 'household' },
    { name: 'Lizol Floor Cleaner — 500ml', slug: 'lizol-floor-cleaner-500ml', price: 110, unit: 'piece', stock: 180, category: 'household' },

    // Baby Care
    { name: 'Pampers Diapers — Medium 20 Pack', slug: 'pampers-diapers-m-20', price: 550, unit: 'pack', stock: 80, category: 'baby-care' },
    { name: 'Cerelac — Stage 1 — 300g', slug: 'cerelac-stage1-300g', price: 275, unit: 'piece', stock: 100, category: 'baby-care' },
  ]

  let count = 0
  for (const p of products) {
    const categoryId = catMap[p.category]
    if (!categoryId) continue

    await pool.query(
      `INSERT INTO products (id, name, slug, price, unit, stock_quantity, category_id, is_featured, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
       ON CONFLICT (slug) DO NOTHING`,
      [uuidv4(), p.name, p.slug, p.price, p.unit, p.stock, categoryId, p.featured || false]
    )
    count++
  }

  console.log(`  ✅ ${count} products seeded`)
}
