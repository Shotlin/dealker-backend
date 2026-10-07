/**
 * Demo data for the Dealker marketplace admin: vendors (all KYC states), shops,
 * catalog, seller listings (all approval states), customers, orders with
 * seller orders / shipments / returns, settlement ledger + payouts, reviews,
 * coupons, loyalty and referrals.
 *
 * Idempotent: exits early when the demo vendors already exist.
 * Run:  docker compose exec api node scripts/seed-marketplace-demo.mjs
 */
import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcrypt'
import crypto from 'node:crypto'

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})

// ── deterministic RNG ───────────────────────────────────────────────────
let seed = 20261007
const rnd = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (a) => a[Math.floor(rnd() * a.length)]
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1))
const round2 = (n) => Math.round(n * 100) / 100
const uuid = () => crypto.randomUUID()
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
const daysAgo = (d, hour = int(8, 21)) => {
  const t = new Date(Date.now() - d * 86400000)
  t.setHours(hour, int(0, 59), int(0, 59), 0)
  return t
}
const addHours = (d, h) => new Date(d.getTime() + h * 3600000)

// ── reference data ──────────────────────────────────────────────────────
const CATEGORIES = {
  Electronics: [
    ['boAt Rockerz 450 Bluetooth Headphones', 'boAt', 1499, 3999],
    ['Redmi 12 5G (8GB/256GB)', 'Redmi', 12999, 17999],
    ['Noise ColorFit Pulse Smartwatch', 'Noise', 1799, 4999],
    ['Mi 10000mAh Power Bank 3i', 'Mi', 1199, 1999],
    ['Logitech M221 Silent Wireless Mouse', 'Logitech', 599, 995],
    ['Portronics Pure Sound Soundbar', 'Portronics', 2499, 5999],
    ['TP-Link Archer C6 AC1200 Router', 'TP-Link', 2199, 3499],
    ['Anker 20W USB-C Fast Charger', 'Anker', 1299, 1999],
  ],
  Fashion: [
    ['Roadster Men Slim Fit Casual Shirt', 'Roadster', 649, 1599],
    ['Libas Women Printed Anarkali Kurta', 'Libas', 899, 2299],
    ['Puma Men Running Shoes', 'Puma', 2799, 5999],
    ['Levis 511 Slim Fit Jeans', 'Levis', 1999, 3999],
    ['Fabindia Cotton Kurta Set', 'Fabindia', 1699, 2999],
    ['Wildcraft 35L Laptop Backpack', 'Wildcraft', 1399, 2495],
    ['Fastrack Analog Women Watch', 'Fastrack', 1195, 1995],
    ['Allen Solly Formal Trousers', 'Allen Solly', 1299, 2499],
  ],
  'Home & Kitchen': [
    ['Prestige Svachh 3L Pressure Cooker', 'Prestige', 1749, 2650],
    ['Milton Thermosteel 1L Flask', 'Milton', 799, 1250],
    ['Philips Daily Collection Mixer Grinder', 'Philips', 2799, 3995],
    ['Wakefit Orthopedic Memory Foam Mattress', 'Wakefit', 8999, 15999],
    ['Cello Opalware Dinner Set (18 pcs)', 'Cello', 1599, 2999],
    ['Pigeon Non-Stick Cookware Set', 'Pigeon', 1899, 3200],
    ['Solimo Microfibre Bedsheet Double', 'Solimo', 699, 1499],
    ['Havells Instanio 3L Water Heater', 'Havells', 3499, 5200],
  ],
  Beauty: [
    ['Lakme 9to5 Primer + Matte Lipstick', 'Lakme', 449, 650],
    ['Mamaearth Vitamin C Face Wash', 'Mamaearth', 279, 349],
    ['Dove Intense Repair Shampoo 650ml', 'Dove', 449, 720],
    ['Minimalist 10% Niacinamide Serum', 'Minimalist', 549, 699],
    ['Philips BT1232 Beard Trimmer', 'Philips', 1099, 1495],
    ['Forest Essentials Soundarya Cream', 'Forest Essentials', 2650, 3100],
  ],
  'Sports & Fitness': [
    ['Cosco Football Size 5', 'Cosco', 449, 700],
    ['Nivia Yoga Mat 6mm', 'Nivia', 499, 899],
    ['Boldfit Adjustable Dumbbell Set 20kg', 'Boldfit', 2499, 3999],
    ['Yonex Mavis 350 Nylon Shuttle', 'Yonex', 899, 1100],
    ['Decathlon Kalenji Running Shorts', 'Kalenji', 599, 999],
    ['Strauss Skipping Rope', 'Strauss', 199, 350],
  ],
  'Books & Stationery': [
    ['Atomic Habits - James Clear', 'Penguin', 399, 799],
    ['The Psychology of Money', 'Jaico', 299, 399],
    ['Classmate Notebook Pack of 6', 'Classmate', 349, 480],
    ['Pilot V5 Hi-Tecpoint Pen (Pack of 5)', 'Pilot', 399, 550],
    ['Ikigai - Hector Garcia', 'Penguin', 249, 399],
  ],
  'Toys & Baby': [
    ['Funskool Giggles Building Blocks 120 pcs', 'Funskool', 549, 899],
    ['Hot Wheels 5-Car Gift Pack', 'Hot Wheels', 449, 599],
    ['Pampers Pants Diapers M (76 count)', 'Pampers', 899, 1299],
    ['Chicco Baby Feeding Bottle 250ml', 'Chicco', 399, 575],
  ],
  Grocery: [
    ['Tata Sampann Unpolished Toor Dal 1kg', 'Tata Sampann', 159, 195],
    ['Aashirvaad Select Atta 5kg', 'Aashirvaad', 289, 345],
    ['Fortune Sunlite Refined Oil 5L', 'Fortune', 689, 865],
    ['Nescafe Classic Instant Coffee 200g', 'Nescafe', 549, 675],
  ],
}

const VENDORS = [
  ['Urbanloom Textiles', 'Surat', 'Gujarat', '395003', 'ACTIVE', ['Fashion']],
  ['TechNest Retail', 'Bengaluru', 'Karnataka', '560034', 'ACTIVE', ['Electronics']],
  ['Kitchen Kart India', 'Pune', 'Maharashtra', '411045', 'ACTIVE', ['Home & Kitchen', 'Grocery']],
  ['Glow & Co Beauty', 'Mumbai', 'Maharashtra', '400053', 'ACTIVE', ['Beauty']],
  ['FitStreet Sports', 'Delhi', 'Delhi', '110019', 'ACTIVE', ['Sports & Fitness']],
  ['PageTurner Books', 'Kolkata', 'West Bengal', '700019', 'ACTIVE', ['Books & Stationery', 'Toys & Baby']],
  ['Gadget Galaxy', 'Hyderabad', 'Telangana', '500081', 'ACTIVE', ['Electronics']],
  ['Ethnic Elegance', 'Jaipur', 'Rajasthan', '302001', 'VERIFIED', ['Fashion']],
  ['HomeNest Living', 'Chennai', 'Tamil Nadu', '600042', 'KYC_SUBMITTED', ['Home & Kitchen']],
  ['Little Stars Toys', 'Ahmedabad', 'Gujarat', '380015', 'KYC_SUBMITTED', ['Toys & Baby']],
  ['Daily Basket Foods', 'Lucknow', 'Uttar Pradesh', '226010', 'UNDER_REVIEW', ['Grocery']],
  ['StyleBazaar Fashion', 'Indore', 'Madhya Pradesh', '452001', 'CORRECTION_REQUIRED', ['Fashion']],
  ['QuickFix Electronics', 'Noida', 'Uttar Pradesh', '201301', 'SUSPENDED', ['Electronics']],
  ['Green Leaf Organics', 'Kochi', 'Kerala', '682016', 'PENDING_ONBOARDING', ['Grocery']],
]

const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Arjun', 'Rohan', 'Karan', 'Rahul', 'Siddharth', 'Ananya', 'Diya', 'Priya', 'Neha', 'Pooja', 'Sneha', 'Kavya', 'Ishita', 'Meera', 'Riya', 'Aisha', 'Tanvi', 'Manish', 'Suresh', 'Deepak', 'Vikram', 'Amit', 'Nikhil', 'Shreya', 'Divya', 'Anjali', 'Rajesh']
const LAST = ['Sharma', 'Verma', 'Gupta', 'Patel', 'Singh', 'Reddy', 'Iyer', 'Nair', 'Mehta', 'Das', 'Joshi', 'Kulkarni', 'Banerjee', 'Chopra', 'Malhotra', 'Bose', 'Rao', 'Pillai', 'Shah', 'Agarwal']
const CITIES = [
  ['Mumbai', 'Maharashtra', '400001'], ['Delhi', 'Delhi', '110001'], ['Bengaluru', 'Karnataka', '560001'],
  ['Hyderabad', 'Telangana', '500001'], ['Chennai', 'Tamil Nadu', '600001'], ['Kolkata', 'West Bengal', '700001'],
  ['Pune', 'Maharashtra', '411001'], ['Ahmedabad', 'Gujarat', '380001'], ['Jaipur', 'Rajasthan', '302001'],
  ['Lucknow', 'Uttar Pradesh', '226001'], ['Surat', 'Gujarat', '395001'], ['Kochi', 'Kerala', '682001'],
]

const img = (s, n = 0) => `https://picsum.photos/seed/${encodeURIComponent(s)}${n || ''}/600/600`

async function main() {
  const c = await pool.connect()
  try {
    const { rows: ex } = await c.query(`SELECT 1 FROM vendors WHERE slug = 'urbanloom-textiles'`)
    if (ex[0]) { console.log('Demo data already present — nothing to do.'); return }
    const origQuery = c.query.bind(c)
    c.query = (...a) => origQuery(...a).catch((e) => { if (typeof a[0] === 'string') console.error('SQL:', a[0].replace(/\s+/g, ' ').slice(0, 160)); throw e })
    await c.query('BEGIN')

    const { rows: adminRows } = await c.query(`SELECT id FROM users WHERE email = 'superadmin@dealker.local' LIMIT 1`)
    const adminId = adminRows[0]?.id ?? null

    // ── categories ───────────────────────────────────────────────────────
    const catId = {}
    let sort = 0
    for (const name of Object.keys(CATEGORIES)) {
      const { rows } = await c.query(
        `INSERT INTO categories (name, slug, description, image_url, sort_order, is_active)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [name, slugify(name), `${name} from verified sellers`, img(`cat-${name}`), sort++],
      )
      catId[name] = rows[0].id
    }

    // ── master products ──────────────────────────────────────────────────
    const products = [] // {id,name,cat,brand,mrp,price}
    for (const [cat, list] of Object.entries(CATEGORIES)) {
      for (const [name, brand, price, mrp] of list) {
        const id = uuid()
        const rating = round2(3.6 + rnd() * 1.3)
        await c.query(
          `INSERT INTO products (id,name,slug,description,price,sale_price,category_id,stock_quantity,unit,thumbnail_url,images,
             is_active,is_featured,sku,brand,hsn_code,gst_rate,avg_rating,rating_count,total_sold,return_policy_days,low_stock_threshold)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pc',$9,$10,true,$11,$12,$13,$14,$15,$16,$17,$18,7,10)`,
          [id, name, `${slugify(name)}-${id.slice(0, 4)}`, `${name} — genuine product sold by verified marketplace sellers.`,
            mrp, price, catId[cat], int(40, 400), img(name), JSON.stringify([img(name), img(name, 2)]),
            rnd() < 0.2, `DK-${slugify(brand).slice(0, 4).toUpperCase()}-${int(1000, 9999)}`, brand,
            cat === 'Grocery' ? '1006' : '8517', cat === 'Grocery' ? 5 : 18, rating, int(12, 480), int(30, 900)],
        )
        products.push({ id, name, cat, brand, mrp, price })
      }
    }

    // ── vendors, shops, KYC ──────────────────────────────────────────────
    const vendors = []
    let vi = 0
    for (const [name, city, state, pincode, status, cats] of VENDORS) {
      vi++
      const vid = uuid()
      const slug = slugify(name)
      const created = daysAgo(int(60, 240))
      await c.query(
        `INSERT INTO vendors (id,name,slug,email,phone,status,is_active,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [vid, name, slug, `contact@${slug.replace(/-/g, '')}.in`, `98${String(10000000 + vi * 137911).slice(0, 8)}`,
          status, ['ACTIVE', 'VERIFIED'].includes(status), created],
      )
      await c.query(
        `INSERT INTO vendor_profiles (vendor_id,legal_name,gstin,pan_number,address_line1,city,state,pincode,latitude,longitude)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [vid, `${name} Pvt Ltd`, `${int(10, 36)}ABCDE${int(1000, 9999)}F1Z${int(1, 9)}`, `ABCDE${int(1000, 9999)}F`,
          `${int(1, 99)}, Industrial Area, Phase ${int(1, 4)}`, city, state, pincode, 20 + rnd() * 8, 72 + rnd() * 10],
      )
      if (status !== 'PENDING_ONBOARDING') {
        const docs = [['GSTIN_CERTIFICATE', 'VERIFIED'], ['PAN_CARD', 'VERIFIED'], ['BANK_CANCELLED_CHEQUE', 'VERIFIED'], ['TRADE_LICENSE', 'VERIFIED']]
        for (const [type, dstatus0] of docs) {
          let dstatus = dstatus0
          if (['KYC_SUBMITTED', 'UNDER_REVIEW'].includes(status)) dstatus = 'PENDING'
          if (status === 'CORRECTION_REQUIRED' && type === 'PAN_CARD') dstatus = 'REJECTED'
          await c.query(
            `INSERT INTO vendor_documents (vendor_id,document_type,document_number,file_key,file_url,status,rejection_reason,created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [vid, type, `${type.slice(0, 3)}${int(100000, 999999)}`, `demo/${slug}/${type.toLowerCase()}.pdf`,
              `https://example.com/demo/${slug}/${type.toLowerCase()}.pdf`, dstatus,
              dstatus === 'REJECTED' ? 'Image is blurry — please re-upload a clear scan' : null, daysAgo(int(5, 40))],
          )
        }
        const rev = (action, prev, next, comments, ago) => c.query(
          `INSERT INTO vendor_kyc_reviews (vendor_id,reviewer_id,action,previous_status,new_status,comments,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [vid, action === 'SUBMIT' ? null : adminId, action, prev, next, comments, daysAgo(ago)])
        await rev('SUBMIT', 'PENDING_ONBOARDING', 'KYC_SUBMITTED', 'KYC documents submitted', int(20, 45))
        if (!['KYC_SUBMITTED'].includes(status)) {
          await rev('START_REVIEW', 'KYC_SUBMITTED', 'UNDER_REVIEW', 'Review started', int(10, 19))
          if (status === 'CORRECTION_REQUIRED') await rev('REQUEST_CORRECTION', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'PAN card scan unreadable', 6)
          else if (!['UNDER_REVIEW'].includes(status)) await rev('APPROVE', 'UNDER_REVIEW', 'VERIFIED', 'All documents verified', int(3, 9))
        }
      }
      // Vendor-owned shop (listing identity + pickup address)
      const shopId = uuid()
      const commission = [8, 10, 12, 12, 15][vi % 5]
      await c.query(
        `INSERT INTO shops (id,name,slug,branch_code,description,phone,email,address_line1,city,state,pincode,lat,lng,is_active,is_verified,
           commission_rate,vendor_id,pickup_capable,seller_rating,rating_count,order_prefix,total_orders,total_revenue,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,$18,$19,$20,0,0,$21,$22)`,
        [shopId, name, `${slug}-shop`, `DK${String(vi).padStart(3, '0')}`, `${name} — official store on Dealker`,
          `97${String(20000000 + vi * 91357).slice(0, 8)}`, `orders@${slug.replace(/-/g, '')}.in`, `${int(1, 99)}, Industrial Area`,
          city, state, pincode, 18 + rnd() * 10, 72 + rnd() * 12, ['ACTIVE', 'VERIFIED'].includes(status), status === 'ACTIVE',
          commission, vid, round2(3.7 + rnd() * 1.2), int(20, 900), `DK${vi}`, adminId, created],
      ).catch(async (e) => { throw e })
      vendors.push({ id: vid, shopId, name, status, cats, commission, listings: [] })
    }

    // ── seller listings ──────────────────────────────────────────────────
    for (const v of vendors) {
      if (v.status === 'PENDING_ONBOARDING') continue
      const live = ['ACTIVE'].includes(v.status)
      const mine = products.filter((p) => v.cats.includes(p.cat))
      const chosen = mine.sort(() => rnd() - 0.5).slice(0, Math.min(mine.length, live ? int(8, 14) : int(2, 5)))
      for (const p of chosen) {
        let approval = live ? 'APPROVED' : 'PENDING'
        if (live && rnd() < 0.12) approval = 'PENDING'
        if (live && rnd() < 0.05) approval = 'REJECTED'
        const price = Math.round(p.price * (0.95 + rnd() * 0.15))
        const stock = rnd() < 0.08 ? 0 : int(5, 220)
        const id = uuid()
        v.listings.push({
          id, productId: p.id, name: p.name, price, mrp: p.mrp, approved: approval === 'APPROVED' && stock > 0, stock,
        })
        await c.query(
          `INSERT INTO shop_products (id,shop_id,product_id,price,sale_price,mrp,stock_quantity,low_stock_threshold,max_order_qty,is_available,
             approval_status,approved_at,approved_by,rejection_reason,seller_sku,min_order_qty,handling_time_days,weight_grams,
             cod_eligible,nationwide_shipping_enabled,local_delivery_enabled,listing_status,sold_count,created_at)
           VALUES ($1,$2,$3,$4,$4,$5,$6,10,10,$7,$8,$9,$10,$11,$12,1,$13,$14,$15,true,$16,$17,$18,$19)`,
          [id, v.shopId, p.id, price, p.mrp, stock, stock > 0 && approval === 'APPROVED', approval,
            approval === 'APPROVED' ? daysAgo(int(2, 60)) : null, approval === 'APPROVED' ? adminId : null,
            approval === 'REJECTED' ? 'Images do not match the product title' : null,
            `${slugify(v.name).slice(0, 4).toUpperCase()}-${int(10000, 99999)}`, int(1, 4), int(150, 3000),
            rnd() < 0.7, rnd() < 0.5, stock === 0 ? 'OUT_OF_STOCK' : (rnd() < 0.08 ? 'PAUSED' : 'ACTIVE'),
            int(0, 300), daysAgo(int(3, 90))],
        )
      }
    }
    const sellers = vendors.filter((v) => v.status === 'ACTIVE')

    // ── customers ────────────────────────────────────────────────────────
    const pwHash = await bcrypt.hash('Customer@123', 10)
    const customers = []
    const customerRole = (await c.query(`SELECT id FROM roles WHERE name='Customer' LIMIT 1`)).rows[0]?.id ?? null
    for (let i = 0; i < 48; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`
      const id = uuid()
      const [city, state, pincode] = pick(CITIES)
      const joined = daysAgo(int(2, 150))
      await c.query(
        `INSERT INTO users (id,phone,email,name,role,role_id,is_active,password_hash,loyalty_points,wallet_balance,referral_code,created_at,last_active_at)
         VALUES ($1,$2,$3,$4,'CUSTOMER',$5,true,$6,$7,$8,$9,$10,$11)`,
        [id, `9${String(700000000 + i * 1234567).slice(0, 9)}`, `${slugify(name)}${i}@example.com`, name, customerRole, pwHash,
          int(0, 900), round2(rnd() * 600), `DK${String(100000 + i * 37).slice(0, 6)}`, joined, daysAgo(int(0, 20))],
      )
      const addrId = uuid()
      const addr = { name, phone: `9${String(700000000 + i * 1234567).slice(0, 9)}`, line1: `${int(1, 250)}, ${pick(['MG Road', 'Park Street', 'Nehru Nagar', 'Lake View Apartments', 'Sector 21', 'Green Park'])}`, city, state, pincode }
      await c.query(
        `INSERT INTO addresses (id,user_id,label,address_line1,city,state,pincode,is_default) VALUES ($1,$2,'Home',$3,$4,$5,$6,true)`,
        [addrId, id, addr.line1, city, state, pincode])
      await c.query(`INSERT INTO wallets (user_id,balance) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, round2(rnd() * 600)]).catch(() => {})
      customers.push({ id, name, addr })
    }

    // ── orders ───────────────────────────────────────────────────────────
    const STATUS_MIX = [
      ['DELIVERED', 52], ['OUT_FOR_DELIVERY', 7], ['PACKED', 6], ['CONFIRMED', 8], ['PENDING', 8],
      ['CANCELLED', 7], ['RETURNED', 6], ['RETURN_REQUESTED', 3],
    ]
    const pickStatus = () => {
      let r = rnd() * 100
      for (const [s, w] of STATUS_MIX) { if ((r -= w) < 0) return s }
      return 'DELIVERED'
    }
    const sellerStatusFor = (s) => ({ PENDING: 'ORDER_PLACED' })[s] || s
    const parentStatusFor = (s) => ({ RETURNED: 'REFUNDED', RETURN_REQUESTED: 'DELIVERED' })[s] || s
    const orderSeq = {}
    const ledgerBalance = {}
    const ledgerRows = []
    const deliveredSellerOrders = []
    let ordersCreated = 0

    for (let n = 0; n < 260; n++) {
      // skew toward recent days
      const age = Math.floor(Math.pow(rnd(), 1.6) * 89)
      const placed = daysAgo(age)
      const cust = pick(customers)
      const status = age < 1 ? pick(['PENDING', 'CONFIRMED', 'PENDING']) : age < 3 ? pick(['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'PENDING']) : pickStatus()
      const nVendors = rnd() < 0.2 ? 2 : 1
      const picked = sellers.sort(() => rnd() - 0.5).slice(0, nVendors).filter((v) => v.listings.some((l) => l.approved))
      if (!picked.length) continue

      const isCod = rnd() < 0.3
      const ymd = placed.toISOString().slice(2, 10).replace(/-/g, '')
      orderSeq[ymd] = (orderSeq[ymd] || 0) + 1
      const orderNo = `MK-${ymd}-${String(orderSeq[ymd]).padStart(4, '0')}`
      const orderId = uuid()

      const groups = picked.map((v) => {
        const lines = v.listings.filter((l) => l.approved).sort(() => rnd() - 0.5).slice(0, int(1, 3)).map((l) => ({ l, qty: int(1, 2) }))
        const subtotal = round2(lines.reduce((s, x) => s + x.l.price * x.qty, 0))
        const shipping = subtotal >= 499 ? 0 : 49
        const commissionAmt = round2(subtotal * v.commission / 100)
        return { v, lines, subtotal, shipping, commissionAmt }
      })
      const subtotal = round2(groups.reduce((s, g) => s + g.subtotal, 0))
      const shipping = round2(groups.reduce((s, g) => s + g.shipping, 0))
      const tax = round2(subtotal * 0.18 / 1.18)
      const discount = rnd() < 0.25 ? round2(Math.min(subtotal * 0.1, 250)) : 0
      const total = round2(subtotal + shipping - discount)
      const paid = isCod ? status === 'DELIVERED' : !['PENDING', 'CANCELLED'].includes(status)
      const payStatus = status === 'RETURNED' ? 'REFUNDED' : paid ? 'PAID' : status === 'CANCELLED' && !isCod ? 'REFUNDED' : 'PENDING'
      const parentStatus = parentStatusFor(status)
      const deliveredAt = ['DELIVERED', 'RETURNED', 'RETURN_REQUESTED'].includes(status) ? addHours(placed, int(60, 160)) : null

      await c.query(
        `INSERT INTO orders (id,order_number,customer_id,status,items,subtotal,discount_amount,delivery_fee,tax_amount,total_payable,
           payment_method,payment_status,coupon_code,delivery_address,delivered_at,cancelled_reason,created_at,updated_at,is_marketplace,
           shipping_charge,coupon_discount_amount,shop_id,delivery_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,true,$8,$7,NULL,'ASAP')`,
        [orderId, orderNo, cust.id, parentStatus, JSON.stringify(groups.flatMap((g) => g.lines.map((x) => ({ name: x.l.name, qty: x.qty, price: x.l.price })))),
          subtotal, discount, shipping, tax, total, isCod ? 'COD' : 'ONLINE', payStatus, discount ? 'WELCOME10' : null,
          JSON.stringify({ ...cust.addr, label: 'Home' }), deliveredAt,
          status === 'CANCELLED' ? pick(['Changed my mind', 'Ordered by mistake', 'Found a better price', 'Delivery taking too long']) : null, placed],
      )
      // status history
      const timeline = ['PENDING']
      for (const s of ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
        if (parentStatus === 'CANCELLED' || parentStatus === 'PENDING') break
        timeline.push(s)
        if (s === parentStatus || (parentStatus === 'REFUNDED' && s === 'DELIVERED')) break
      }
      if (parentStatus === 'CANCELLED') timeline.push('CANCELLED')
      if (parentStatus === 'REFUNDED') timeline.push('REFUNDED')
      let prev = null; let t = placed
      for (const s of timeline) {
        await c.query(`INSERT INTO order_status_history (order_id,from_status,to_status,changed_by,changed_at) VALUES ($1,$2,$3,$4,$5)`,
          [orderId, prev, s, s === 'PENDING' ? cust.id : adminId, t])
        prev = s; t = addHours(t, int(4, 40))
      }
      if (!isCod && payStatus !== 'PENDING') {
        await c.query(
          `INSERT INTO payments (order_id,user_id,razorpay_order_id,razorpay_payment_id,amount,currency,status,method,refund_amount,refund_status,created_at)
           VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,$9,$10)`,
          [orderId, cust.id, `order_${crypto.randomBytes(7).toString('hex')}`, `pay_${crypto.randomBytes(7).toString('hex')}`, total,
            payStatus === 'REFUNDED' ? 'REFUNDED' : 'CAPTURED', pick(['upi', 'card', 'netbanking', 'wallet']),
            payStatus === 'REFUNDED' ? total : null, payStatus === 'REFUNDED' ? 'PROCESSED' : null, placed])
      }

      // seller orders + items + shipments + ledger
      let suffix = 0
      for (const g of groups) {
        suffix++
        const soId = uuid()
        const soNo = `${orderNo}-${String.fromCharCode(64 + suffix)}`
        const sStatus = sellerStatusFor(status)
        const fulfil = { ORDER_PLACED: 'PENDING', CONFIRMED: 'PROCESSING', PACKED: 'PACKED', OUT_FOR_DELIVERY: 'DISPATCHED',
          DELIVERED: 'DELIVERED', RETURNED: 'DELIVERED', RETURN_REQUESTED: 'DELIVERED', CANCELLED: 'CANCELLED' }[sStatus]
        const eligible = deliveredAt && Date.now() - deliveredAt.getTime() > 7 * 86400000
        let payout = 'PENDING'
        if (sStatus === 'DELIVERED') payout = eligible ? 'ELIGIBLE' : 'PENDING'
        if (sStatus === 'RETURNED' || sStatus === 'CANCELLED') payout = 'REVERSED'
        if (sStatus === 'RETURN_REQUESTED') payout = 'ON_HOLD'
        const payable = round2(g.subtotal - g.commissionAmt - g.shipping)
        await c.query(
          `INSERT INTO seller_orders (id,order_id,seller_order_number,vendor_id,shop_id,status,item_subtotal,commission_rate,commission_amount,
             shipping_charge,payable_to_seller,fulfilment_status,payout_status,shipped_at,delivered_at,cancelled_at,cancellation_reason,created_at,updated_at,estimated_delivery)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19)`,
          [soId, orderId, soNo, g.v.id, g.v.shopId, sStatus, g.subtotal, g.v.commission, g.commissionAmt, g.shipping, Math.max(payable, 0),
            fulfil, payout, ['OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'RETURN_REQUESTED'].includes(sStatus) ? addHours(placed, int(24, 48)) : null,
            deliveredAt, sStatus === 'CANCELLED' ? addHours(placed, int(1, 20)) : null,
            sStatus === 'CANCELLED' ? 'Cancelled by customer' : null, placed, addHours(placed, int(72, 168))])
        for (const x of g.lines) {
          await c.query(
            `INSERT INTO order_items (order_id,product_id,product_name,unit_price,quantity,unit,subtotal,shop_product_id,shop_id,seller_order_id,commission_rate,created_at)
             VALUES ($1,$2,$3,$4,$5,'pc',$6,$7,$8,$9,$10,$11)`,
            [orderId, x.l.productId, x.l.name, x.l.price, x.qty, round2(x.l.price * x.qty), x.l.id, g.v.shopId, soId, g.v.commission, placed])
        }
        // shipment
        if (['OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'RETURN_REQUESTED', 'PACKED'].includes(sStatus)) {
          const provider = pick(['SHIPROCKET', 'SHIPROCKET', 'BLUEDART', 'PORTER', 'SELF'])
          const shStatus = { PACKED: 'PICKUP_SCHEDULED', OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY' }[sStatus] || 'DELIVERED'
          const shId = uuid()
          const awb = `${provider.slice(0, 2)}${int(10000000, 99999999)}`
          await c.query(
            `INSERT INTO shipments (id,seller_order_id,provider,provider_order_id,awb,courier_name,pickup_location,shipping_charge,cod_amount,status,
               provider_status,estimated_delivery,tracking_url,created_at,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text,$10::text,$11,$12,$13,$13)`,
            [shId, soId, provider, `SR-${int(100000, 999999)}`, awb,
              pick(['Delhivery', 'Blue Dart', 'Ecom Express', 'XpressBees', 'DTDC']), g.v.name, g.shipping, isCod ? total : 0, shStatus,
              addHours(placed, int(72, 168)), `https://track.dealker.in/${awb}`, addHours(placed, int(8, 30))])
          await c.query(`UPDATE seller_orders SET shipment_id=$1, shipping_provider=$2 WHERE id=$3`, [shId, provider, soId])
          const evs = [['CREATED', 'Shipment created', g.v.city], ['PICKUP_SCHEDULED', 'Pickup scheduled', g.v.city]]
          if (shStatus !== 'PICKUP_SCHEDULED') evs.push(['PICKED_UP', 'Picked up from seller', g.v.city], ['IN_TRANSIT', 'In transit to destination hub', 'Transit hub'], ['OUT_FOR_DELIVERY', 'Out for delivery', cust.addr.city])
          if (shStatus === 'DELIVERED') evs.push(['DELIVERED', 'Delivered to customer', cust.addr.city])
          let et = addHours(placed, 10)
          for (const [s, note, loc] of evs) {
            await c.query(`INSERT INTO shipment_events (shipment_id,status,provider_status,note,event_location,occurred_at,created_at) VALUES ($1,$2,$2,$3,$4,$5,$5)`, [shId, s, note, loc, et])
            et = addHours(et, int(6, 30))
          }
        }
        // ledger rows for delivered/returned orders
        if (['DELIVERED', 'RETURNED', 'RETURN_REQUESTED'].includes(sStatus)) {
          deliveredSellerOrders.push({ soId, g, at: deliveredAt, sStatus })
        }
      }

      // refund request for returns / prepaid cancellations
      if (['RETURNED', 'RETURN_REQUESTED'].includes(status) || (status === 'CANCELLED' && !isCod && rnd() < 0.6)) {
        const rs = status === 'RETURN_REQUESTED' ? 'PENDING' : status === 'RETURNED' ? pick(['APPROVED', 'APPROVED', 'PROCESSING']) : 'APPROVED'
        await c.query(
          `INSERT INTO refund_requests (order_id,customer_id,scope,reason,status,refund_destination,computed_amount,resolved_amount,source,
             resolved_at,resolved_by,refunded_at,created_at,updated_at)
           VALUES ($1,$2,'FULL_ORDER',$3,$4,$5,$6,$7,'CUSTOMER',$8,$9,$10,$11,$11)`,
          [orderId, cust.id,
            status === 'CANCELLED' ? 'Order cancelled before dispatch' : pick(['Product damaged on arrival', 'Wrong item received', 'Size does not fit', 'Not as described', 'Quality not as expected']),
            rs, isCod ? 'WALLET' : pick(['RAZORPAY', 'RAZORPAY', 'WALLET']), total, rs === 'APPROVED' ? total : null,
            rs === 'APPROVED' ? addHours(placed, 190) : null, rs === 'APPROVED' ? adminId : null, rs === 'APPROVED' ? addHours(placed, 195) : null,
            addHours(deliveredAt || placed, int(6, 60))])
      }
      ordersCreated++
    }

    // ── settlement ledger (chronological per vendor) ─────────────────────
    deliveredSellerOrders.sort((a, b) => a.at - b.at)
    const ins = []
    const post = (vendorId, soId, type, amount, key, at, reason = null) => {
      if (!amount) return
      ledgerBalance[vendorId] = round2((ledgerBalance[vendorId] || 0) + amount)
      ins.push([soId, vendorId, type, amount, ledgerBalance[vendorId], reason, key, at])
    }
    for (const { soId, g, at, sStatus } of deliveredSellerOrders) {
      post(g.v.id, soId, 'GROSS_SALES', g.subtotal, `st:${soId}:GROSS`, at)
      post(g.v.id, soId, 'COMMISSION', -g.commissionAmt, `st:${soId}:COMM`, at)
      post(g.v.id, soId, 'LOGISTICS', -g.shipping, `st:${soId}:LOG`, at)
      if (sStatus === 'RETURNED') post(g.v.id, soId, 'REFUND', -round2(g.subtotal - g.commissionAmt), `st:${soId}:REFUND`, addHours(at, 48), 'Order returned by customer')
    }
    // payouts: pay out ~65% of each vendor's balance as historical PAID payouts, plus pending ones
    let po = 0
    const payouts = []
    for (const v of sellers) {
      const bal = ledgerBalance[v.id] || 0
      if (bal <= 0) continue
      const parts = [['PAID', 0.3, 45], ['PAID', 0.25, 20], [pick(['PROCESSING', 'PENDING']), 0.15, 2]]
      for (const [st, share, ago] of parts) {
        const amt = round2(bal * share)
        if (amt <= 0) continue
        po++
        const id = uuid()
        const at = daysAgo(ago, 11)
        payouts.push([id, v.id, `PO-${String(po).padStart(6, '0')}`, amt, st, daysAgo(ago + 14), daysAgo(ago), st === 'PAID' ? `UTR${int(100000000000, 999999999999)}` : null, st === 'PAID' ? at : null, adminId, at])
        if (st !== 'PENDING') {
          ledgerBalance[v.id] = round2(ledgerBalance[v.id] - amt)
          ins.push([null, v.id, 'PAYOUT', -amt, ledgerBalance[v.id], `Payout PO-${String(po).padStart(6, '0')}`, `payout:${id}`, at])
        }
      }
    }
    for (const p of payouts) {
      await c.query(
        `INSERT INTO settlement_payouts (id,vendor_id,payout_number,amount,status,period_start,period_end,utr_number,paid_at,created_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, p)
    }
    for (const r of ins) {
      await c.query(
        `INSERT INTO settlement_ledger (seller_order_id,vendor_id,entry_type,amount,balance_after,reason,idempotency_key,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, r)
    }
    if (sellers[0]) {
      await c.query(`INSERT INTO settlement_holds (vendor_id,reason,is_active,created_by) VALUES ($1,'Pending dispute review on return rate',true,$2)`, [sellers[3].id, adminId])
    }

    // ── shop aggregates ──────────────────────────────────────────────────
    await c.query(`UPDATE shops s SET total_orders = x.n, total_revenue = x.r FROM (
        SELECT shop_id, COUNT(*) n, COALESCE(SUM(item_subtotal),0) r FROM seller_orders WHERE status NOT IN ('CANCELLED') GROUP BY shop_id) x
      WHERE s.id = x.shop_id`)
    await c.query(`UPDATE shop_products sp SET sold_count = x.q FROM (
        SELECT shop_product_id, SUM(quantity)::int q FROM order_items GROUP BY shop_product_id) x WHERE sp.id = x.shop_product_id`)

    // ── reviews ──────────────────────────────────────────────────────────
    const { rows: delivered } = await c.query(
      `SELECT o.id order_id, o.customer_id, oi.product_id FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.status='DELIVERED' ORDER BY random() LIMIT 90`)
    const comments = ['Great quality, exactly as described.', 'Fast delivery and well packed.', 'Value for money. Happy with the purchase.', 'Decent product but packaging could be better.', 'Excellent! Will buy again.', 'Average — expected a little more for the price.', 'Superb build quality.']
    const seen = new Set()
    for (const d of delivered) {
      const key = `${d.customer_id}:${d.product_id}`
      if (seen.has(key)) continue
      seen.add(key)
      await c.query(`INSERT INTO reviews (user_id,product_id,order_id,rating,comment,is_verified_purchase,created_at) VALUES ($1,$2,$3,$4,$5,true,$6)`,
        [d.customer_id, d.product_id, d.order_id, pick([5, 5, 5, 4, 4, 4, 3, 2]), pick(comments), daysAgo(int(1, 40))]).catch(() => {})
    }

    // ── coupons ──────────────────────────────────────────────────────────
    const coupons = [
      ['WELCOME10', 'PERCENTAGE', 10, 499, 250, 'PLATFORM_COUPON', 'PLATFORM', 'Flat 10% off on your first order'],
      ['FESTIVE200', 'FLAT', 200, 1999, 200, 'PLATFORM_COUPON', 'PLATFORM', '₹200 off on orders above ₹1,999'],
      ['FREESHIP', 'FREE_DELIVERY', 1, 299, null, 'DELIVERY_COUPON', 'PLATFORM', 'Free shipping on orders above ₹299'],
      ['SAVE15', 'PERCENTAGE', 15, 999, 500, 'PLATFORM_COUPON', 'PLATFORM', '15% off up to ₹500'],
      ['EXPIRED5', 'PERCENTAGE', 5, 0, 100, 'PLATFORM_COUPON', 'PLATFORM', 'Expired demo coupon'],
    ]
    for (const [code, type, val, min, max, ctype, absorber, desc] of coupons) {
      await c.query(
        `INSERT INTO coupons (code,description,discount_type,discount_value,min_order_amount,max_discount,usage_limit,used_count,valid_from,valid_until,
           is_active,coupon_type,absorber,target_type,grants_free_delivery,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,1000,$7,$8,$9,$10,$11,$12,'ALL',$13,$14)`,
        [code, desc, type, val, min, max, int(20, 400), daysAgo(60), code === 'EXPIRED5' ? daysAgo(5) : daysAgo(-60), code !== 'EXPIRED5', ctype, absorber, type === 'FREE_DELIVERY', adminId])
    }

    // ── loyalty + referrals ──────────────────────────────────────────────
    for (const cu of customers.slice(0, 30)) {
      const pts = int(50, 1800)
      const { rows } = await c.query(`INSERT INTO loyalty_accounts (customer_id,points_balance) VALUES ($1,$2) RETURNING id`, [cu.id, pts])
      await c.query(`INSERT INTO loyalty_transactions (loyalty_account_id,transaction_type,points,balance_after,idempotency_key,created_at,available_at)
                     VALUES ($1,'EARN',$2,$2,$3,$4::timestamptz,$4::timestamptz)`, [rows[0].id, pts, `demo-earn:${cu.id}`, daysAgo(int(2, 60))])
    }
    for (let i = 0; i < 10; i++) {
      const { rows } = await c.query(`INSERT INTO referral_codes (user_id,code,is_active) VALUES ($1,$2,true) RETURNING id`, [customers[i].id, `REF${customers[i].id.slice(0, 6).toUpperCase()}`])
      const friend = customers[20 + i]
      await c.query(
        `INSERT INTO referrals (referrer_id,referred_user_id,referral_code_id,status,registered_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$5)`, [customers[i].id, friend.id, rows[0].id, pick(['REGISTERED', 'REGISTERED', 'QUALIFIED', 'REWARDED']), daysAgo(int(2, 50))]).catch(() => {})
    }

    await c.query('COMMIT')
    console.log(`✅ Demo data ready: ${vendors.length} vendors, ${products.length} products, ${customers.length} customers, ${ordersCreated} orders`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    console.error('Seed failed:', e.message)
    process.exitCode = 1
  } finally {
    c.release()
    await pool.end()
  }
}

main()
