import 'dotenv/config'

import { getClient } from '../src/config/database.js'
import { cacheDeletePattern } from '../src/utils/cache.js'

const DAY_MS = 24 * 60 * 60 * 1000
const ADMIN_USER_ID = 'be6c0caa-8597-4d43-be4f-a34eae62d3da'

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

const BRAND_LOGOS = {
  Amul: 'https://logo.clearbit.com/amul.com',
  Aashirvaad: 'https://logo.clearbit.com/itcportal.com',
  Britannia: 'https://logo.clearbit.com/britannia.co.in',
  'Coca-Cola': 'https://logo.clearbit.com/coca-cola.com',
  Dove: 'https://logo.clearbit.com/dove.com',
  Everest: 'https://logo.clearbit.com/everestspices.com',
  Fortune: 'https://logo.clearbit.com/fortunefoods.com',
  Haldiram: 'https://logo.clearbit.com/haldirams.com',
  'Head & Shoulders': 'https://logo.clearbit.com/headandshoulders.com',
  'India Gate': 'https://logo.clearbit.com/indiagatefoods.com',
  "Lay's": 'https://logo.clearbit.com/lays.com',
  Lizol: 'https://logo.clearbit.com/reckitt.com',
  MDH: 'https://logo.clearbit.com/mdhspices.com',
  Nescafe: 'https://logo.clearbit.com/nescafe.com',
  Nestle: 'https://logo.clearbit.com/nestle.com',
  Pampers: 'https://logo.clearbit.com/pampers.com',
  Parle: 'https://logo.clearbit.com/parleproducts.com',
  Real: 'https://logo.clearbit.com/dabur.com',
  'Surf Excel': 'https://logo.clearbit.com/unilever.com',
  'Tata Tea': 'https://logo.clearbit.com/tataconsumer.com',
  'Tata Sampann': 'https://logo.clearbit.com/tataconsumer.com',
}

const VENDORS = {
  fresh: {
    name: 'Bakaloo Fresh Sourcing',
    address: 'APMC Market Yard, Whitefield Link Road, Bengaluru, Karnataka 560066',
    fssai: '11223888000121',
  },
  coldChain: {
    name: 'Bakaloo Cold Chain Foods',
    address: 'Warehouse 7, KIADB Food Park, Devanahalli, Karnataka 562110',
    fssai: '11223999000451',
  },
  retail: {
    name: 'Bakaloo Retail Supplies',
    address: 'Plot 14, Industrial Estate Phase 2, Bengaluru, Karnataka 560048',
    fssai: '11223111000987',
  },
  essentials: {
    name: 'Bakaloo Essentials Distribution',
    address: 'Unit 3, Logistics Park, Hoskote Road, Bengaluru, Karnataka 560067',
    fssai: null,
  },
  essentialsFood: {
    name: 'Bakaloo Essentials Distribution',
    address: 'Unit 3, Logistics Park, Hoskote Road, Bengaluru, Karnataka 560067',
    fssai: '11223111000987',
  },
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function titleCase(value) {
  return String(value)
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

function foodProduct(config) {
  return {
    family: config.family,
    vendorKey: config.vendorKey ?? 'retail',
    returnPolicy: config.returnPolicy ?? 'no_return',
    certifications: config.certifications ?? ['FSSAI'],
    isAuthentic: true,
    seedReviewCount: config.seedReviewCount ?? (config.ratingCount >= 200 ? 3 : 2),
    orderQty: config.orderQty ?? 1,
    maxOrderQty: config.maxOrderQty ?? 5,
    ...config,
  }
}

function freshProduct(config) {
  return {
    family: 'fresh',
    vendorKey: 'fresh',
    returnPolicy: 'no_return',
    certifications: ['FSSAI'],
    isAuthentic: true,
    seedReviewCount: config.seedReviewCount ?? 2,
    orderQty: config.orderQty ?? 1,
    maxOrderQty: config.maxOrderQty ?? 5,
    ...config,
  }
}

function essentialProduct(config) {
  return {
    family: config.family,
    vendorKey: 'essentials',
    returnPolicy: config.returnPolicy ?? '7_day',
    certifications: config.certifications ?? [],
    isAuthentic: true,
    seedReviewCount: config.seedReviewCount ?? 2,
    orderQty: config.orderQty ?? 1,
    maxOrderQty: config.maxOrderQty ?? 4,
    nutritionInfo: null,
    ...config,
  }
}

function categoryLabel(family) {
  const labels = {
    fresh: 'Fruits & Vegetables',
    dairy: 'Dairy & Eggs',
    bakery: 'Bakery & Bread',
    baby: 'Baby Care',
    beverages: 'Beverages',
    oils: 'Cooking Oils',
    frozen: 'Frozen Food',
    staples: 'Rice & Grains',
    snacks: 'Snacks & Chips',
    spices: 'Masala & Spices',
    personal: 'Personal Care',
    household: 'Household',
  }
  return labels[family] ?? titleCase(family)
}

function normalizeSentence(value) {
  return String(value ?? '').replace(/\.$/, '').trim()
}

function lowerFirst(value) {
  const normalized = normalizeSentence(value)
  if (!normalized) return ''
  return normalized.charAt(0).toLowerCase() + normalized.slice(1)
}

function buildHighlights(config) {
  return {
    'Product Type': config.productType,
    'Pack Size': config.netQuantity,
    [config.variantLabel ?? 'Variant']: config.variant,
    'Recommended Use': config.bestFor,
  }
}

function buildAttributes(config) {
  return [
    { label: 'Brand', value: config.brand },
    { label: 'Product Type', value: config.productType },
    { label: 'Net Quantity', value: config.netQuantity },
    { label: config.variantLabel ?? 'Variant', value: config.variant },
    { label: 'Pack Type', value: config.packType },
    { label: 'Shelf Life', value: config.shelfLife },
    { label: 'Storage', value: config.storageInstructions },
    { label: 'Recommended Use', value: config.bestFor },
  ]
}

function buildDescription(name, config) {
  const bestFor = lowerFirst(config.bestFor)
  const storage = normalizeSentence(config.storageInstructions)
  const variantDetail = `${config.variantLabel}: ${config.variant}.`

  if (config.family === 'fresh') {
    return `${name} is packed in ${config.netQuantity} for ${bestFor}. ${variantDetail} ${storage}.`
  }

  return `This pack of ${config.brand} ${lowerFirst(config.productType)} contains ${config.netQuantity} and is suited for ${bestFor}. ${variantDetail} ${storage}.`
}

function buildReviewComments(name, config) {
  if (config.reviewComments) {
    return config.reviewComments
  }

  return [
    `${config.reviewLead}. Packaging was neat and delivery was on time.`,
    `${config.reviewLead}. Good value for money and exactly as described.`,
    `${config.reviewLead}. Feels authentic and I would reorder this again.`,
  ].slice(0, config.seedReviewCount ?? 2)
}

function buildReviewRatings(config) {
  if (config.reviewRatings) {
    return config.reviewRatings
  }

  if (config.avgRating >= 4.6) return [5, 5, 4]
  if (config.avgRating >= 4.4) return [5, 4, 4]
  return [4, 4, 5]
}

function buildSku(index, brand, name) {
  const brandCode = brand.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4).padEnd(4, 'X')
  return `${brandCode}-${String(index + 1).padStart(3, '0')}-${slugify(name).slice(0, 8).toUpperCase()}`
}

function buildBarcode(index) {
  return `8907800${String(100000 + index).slice(-6)}`
}

function buildCostPrice(productPrice, salePrice) {
  const effective = salePrice ?? productPrice
  return Number((effective * 0.74).toFixed(2))
}

function buildTags(config) {
  const tags = new Set(config.tags || [])
  if (config.salePrice) tags.add('on-sale')
  if (config.ratingCount >= 200) tags.add('top-rated')
  if (config.totalSold >= 500) tags.add('bestseller')
  return Array.from(tags)
}

function buildMetaTitle(name, brand) {
  return `${name} | ${brand} | Bakaloo`
}

function buildMetaDescription(config) {
  return `${config.brand} ${config.productType}, ${config.netQuantity}. Suitable for ${config.bestFor.toLowerCase()}.`
}

function buildAddress(index, customer) {
  return {
    name: customer.name,
    phone: customer.phone,
    line1: `${12 + index}, Bakaloo Residency`,
    line2: 'Brookefield Main Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: String(560030 + index).padStart(6, '0'),
    landmark: 'Near Bakaloo Hub',
  }
}

function buildOrderTimestamps(index, variantIndex) {
  const createdAt = new Date(Date.now() - (8 + index * 2 + variantIndex * 9) * DAY_MS)
  const confirmedAt = new Date(createdAt.getTime() + 35 * 60 * 1000)
  const packedAt = new Date(createdAt.getTime() + 90 * 60 * 1000)
  const outForDeliveryAt = new Date(createdAt.getTime() + 3 * 60 * 60 * 1000)
  const deliveredAt = new Date(createdAt.getTime() + 5 * 60 * 60 * 1000)

  return {
    createdAt,
    confirmedAt,
    packedAt,
    outForDeliveryAt,
    deliveredAt,
    estimatedDelivery: new Date(createdAt.getTime() + 45 * 60 * 1000),
  }
}

const PRODUCT_CONFIGS = {
  'Aashirvaad Atta — 5kg': foodProduct({
    family: 'staples',
    brand: 'Aashirvaad',
    netQuantity: '5 kg',
    productType: 'Whole wheat atta',
    variantLabel: 'Flour Type',
    variant: 'Chakki atta',
    bestFor: 'Soft rotis, parathas, and daily cooking',
    special: 'Made from selected whole wheat grains for soft rotis',
    description: 'Aashirvaad Atta is a dependable pantry staple milled for soft rotis, parathas, and everyday Indian meals.',
    ingredients: '100% whole wheat flour.',
    allergenInfo: 'Contains wheat (gluten).',
    shelfLife: '4 months',
    storageInstructions: 'Transfer to an airtight container and store in a cool, dry place.',
    packType: '5 kg family pack',
    nutritionInfo: {
      'Energy (kcal)': '364',
      Protein: '11.8 g',
      Carbohydrate: '72.0 g',
      Fat: '1.7 g',
      Fibre: '10.7 g',
    },
    salePrice: 285,
    avgRating: 4.6,
    ratingCount: 312,
    totalSold: 942,
    tags: ['family-pack', 'daily-staple'],
    reviewLead: 'Good flour quality and rotis stay soft for longer',
  }),
  'Amul Butter — 100g': foodProduct({
    family: 'dairy',
    vendorKey: 'coldChain',
    brand: 'Amul',
    netQuantity: '100 g',
    productType: 'Table butter',
    variantLabel: 'Milk Fat',
    variant: 'Min. 80%',
    bestFor: 'Toast, sandwiches, pav bhaji, and cooking',
    special: 'Classic creamy butter with the familiar Amul taste',
    description: 'Amul Butter brings rich dairy flavour and a creamy spreadable texture for breakfast, baking, and everyday cooking.',
    ingredients: 'Butter, common salt, and permitted natural colour.',
    allergenInfo: 'Contains milk.',
    shelfLife: '12 months under refrigeration',
    storageInstructions: 'Keep refrigerated at 4 C or below.',
    packType: 'Carton pack',
    nutritionInfo: {
      'Energy (kcal)': '722',
      Fat: '80 g',
      'Saturated Fat': '51 g',
      Sodium: '836 mg',
      Protein: '0.5 g',
    },
    salePrice: 52,
    avgRating: 4.7,
    ratingCount: 248,
    totalSold: 811,
    tags: ['breakfast', 'trusted-brand'],
    reviewLead: 'Creamy butter with the same classic taste every time',
  }),
  'Amul Ghee — 500ml': foodProduct({
    family: 'dairy',
    brand: 'Amul',
    vendorKey: 'retail',
    netQuantity: '500 ml',
    productType: 'Pure cow ghee',
    variantLabel: 'Usage',
    variant: 'Cooking, tadka, sweets',
    bestFor: 'Daily cooking, tadka, and festive sweets',
    special: 'Rich aroma and granular texture for home cooking',
    description: 'Amul Ghee is a trusted kitchen essential for aroma-rich tadka, sweets, and everyday cooking.',
    ingredients: 'Pure milk fat.',
    allergenInfo: 'Contains milk.',
    shelfLife: '9 months',
    storageInstructions: 'Store in a cool and dry place. Use a dry spoon.',
    packType: 'Resealable jar',
    nutritionInfo: {
      'Energy (kcal)': '900',
      Fat: '100 g',
      'Saturated Fat': '64 g',
      'Trans Fat': '0 g',
      Cholesterol: '250 mg',
    },
    salePrice: 275,
    avgRating: 4.7,
    ratingCount: 186,
    totalSold: 558,
    tags: ['kitchen-essential'],
    reviewLead: 'Rich ghee aroma and good granular texture',
  }),
  'Amul Ice Cream — Vanilla 1L': foodProduct({
    family: 'frozen',
    vendorKey: 'coldChain',
    brand: 'Amul',
    netQuantity: '1 L',
    productType: 'Vanilla ice cream',
    variantLabel: 'Dessert Type',
    variant: 'Family tub',
    bestFor: 'Dessert, sundaes, and family servings',
    special: 'Creamy vanilla dessert in a freezer-ready family tub',
    description: 'Amul Vanilla Ice Cream is a creamy freezer dessert designed for family servings, sundaes, and post-dinner treats.',
    ingredients: 'Milk solids, sugar, edible vegetable fat, stabilisers, and vanilla flavouring.',
    allergenInfo: 'Contains milk.',
    shelfLife: '9 months frozen',
    storageInstructions: 'Keep frozen at or below -18 C. Do not refreeze once melted.',
    packType: 'Family tub',
    nutritionInfo: {
      'Energy (kcal)': '207',
      Protein: '3.8 g',
      Carbohydrate: '24 g',
      Fat: '10 g',
      Sugar: '21 g',
    },
    salePrice: 189,
    avgRating: 4.6,
    ratingCount: 174,
    totalSold: 468,
    tags: ['dessert', 'family-pack'],
    reviewLead: 'Creamy vanilla flavour and good portion for family dessert',
  }),
  'Amul Toned Milk — 500ml': foodProduct({
    family: 'dairy',
    vendorKey: 'coldChain',
    brand: 'Amul',
    netQuantity: '500 ml',
    productType: 'Toned milk',
    variantLabel: 'Milk Type',
    variant: 'Pasteurised toned milk',
    bestFor: 'Tea, coffee, breakfast, and daily cooking',
    special: 'Daily toned milk packed for freshness and everyday use',
    description: 'Amul Toned Milk is a fresh daily-use milk pack suited for beverages, breakfast bowls, and Indian home cooking.',
    ingredients: 'Standardised toned milk.',
    allergenInfo: 'Contains milk.',
    shelfLife: 'Best before use by date on pack',
    storageInstructions: 'Keep refrigerated and boil before use.',
    packType: 'Pouch pack',
    nutritionInfo: {
      'Energy (kcal)': '62',
      Protein: '3.1 g',
      Carbohydrate: '4.7 g',
      Fat: '3.0 g',
      Calcium: '120 mg',
    },
    salePrice: null,
    avgRating: 4.5,
    ratingCount: 286,
    totalSold: 1064,
    tags: ['daily-fresh', 'breakfast'],
    reviewLead: 'Fresh milk pack and works well for tea and coffee',
    orderQty: 2,
    maxOrderQty: 8,
  }),
  'Apple — Shimla': freshProduct({
    brand: 'Bakaloo Fresh',
    netQuantity: '1 kg',
    productType: 'Shimla apple',
    variantLabel: 'Source',
    variant: 'Himachal Pradesh',
    bestFor: 'Snacking, salads, and fresh juice',
    special: 'Sweet, crisp apples that are hand-sorted before dispatch',
    description: 'Shimla apples sourced for balanced sweetness, crisp bite, and dependable table-fruit quality.',
    shelfLife: '5-7 days refrigerated',
    storageInstructions: 'Refrigerate after delivery for best crunch and freshness.',
    packType: 'Open weight produce',
    nutritionInfo: {
      'Energy (kcal)': '52',
      Fibre: '2.4 g',
      Carbohydrate: '13.8 g',
      'Vitamin C': '4.6 mg',
      Potassium: '107 mg',
    },
    salePrice: 169,
    avgRating: 4.5,
    ratingCount: 184,
    totalSold: 524,
    tags: ['fresh', 'seasonal'],
    reviewLead: 'Apples arrived crisp and looked freshly packed',
    orderQty: 1,
  }),
  'Banana — Robusta': freshProduct({
    brand: 'Bakaloo Fresh',
    netQuantity: '1 kg',
    productType: 'Robusta banana',
    variantLabel: 'Ripeness',
    variant: 'Ready to ripen',
    bestFor: 'Breakfast, smoothies, and quick snacks',
    special: 'Naturally sweet bananas sourced for everyday snacking',
    description: 'Robusta bananas packed for daily snacking, breakfast bowls, and smoothies with a naturally sweet profile.',
    shelfLife: '2-4 days at room temperature',
    storageInstructions: 'Keep in a cool place and refrigerate only after ripening.',
    packType: 'Open weight produce',
    nutritionInfo: {
      'Energy (kcal)': '89',
      Fibre: '2.6 g',
      Carbohydrate: '22.8 g',
      Potassium: '358 mg',
      'Vitamin B6': '0.4 mg',
    },
    salePrice: null,
    avgRating: 4.4,
    ratingCount: 166,
    totalSold: 486,
    tags: ['fresh', 'daily-fruit'],
    reviewLead: 'Good sweetness and the bananas ripened evenly',
    orderQty: 1,
  }),
  'Britannia White Bread': foodProduct({
    family: 'bakery',
    vendorKey: 'coldChain',
    brand: 'Britannia',
    netQuantity: '400 g',
    productType: 'White bread',
    variantLabel: 'Loaf Type',
    variant: 'Soft sliced loaf',
    bestFor: 'Toast, sandwiches, and breakfast platters',
    special: 'Soft sliced bread for everyday breakfast and sandwiches',
    description: 'Britannia White Bread is a soft loaf for sandwiches, toast, and quick breakfast prep.',
    ingredients: 'Refined wheat flour, yeast, sugar, edible oil, and permitted improvers.',
    allergenInfo: 'Contains wheat and may contain milk and soy.',
    shelfLife: '3-5 days',
    storageInstructions: 'Keep sealed in a cool, dry place and consume soon after opening.',
    packType: 'Sliced loaf pack',
    nutritionInfo: {
      'Energy (kcal)': '265',
      Protein: '8.0 g',
      Carbohydrate: '49 g',
      Fat: '4.0 g',
      Sugar: '5.7 g',
    },
    salePrice: 37,
    avgRating: 4.3,
    ratingCount: 142,
    totalSold: 436,
    tags: ['breakfast', 'daily-staple'],
    reviewLead: 'Soft slices and neat packaging for daily breakfast',
    orderQty: 1,
    maxOrderQty: 4,
  }),
  'Cerelac — Stage 1 — 300g': foodProduct({
    family: 'baby',
    vendorKey: 'essentialsFood',
    brand: 'Nestle',
    netQuantity: '300 g',
    productType: 'Infant cereal with milk',
    variantLabel: 'Age Group',
    variant: '6 months+',
    bestFor: 'Weaning meals and quick baby cereal preparation',
    special: 'Wheat Apple infant cereal fortified with iron and key vitamins',
    description: 'Nestle Cerelac Stage 1 in Wheat Apple flavour is designed for early weaning meals with a smooth texture and fortified nutrition.',
    ingredients: 'Cereal flour, milk solids, fruit solids, vitamins, and minerals.',
    allergenInfo: 'Contains milk and wheat.',
    shelfLife: '12 months unopened',
    storageInstructions: 'Store airtight after opening and consume within the pack guidance.',
    packType: 'Sealed carton pack',
    nutritionInfo: {
      'Energy (kcal)': '410',
      Protein: '14 g',
      Carbohydrate: '69 g',
      Fat: '8.5 g',
      Iron: '8 mg',
    },
    salePrice: 249,
    avgRating: 4.6,
    ratingCount: 228,
    totalSold: 612,
    tags: ['baby-care', 'trusted-brand'],
    reviewLead: 'Easy to prepare and the texture works well for baby meals',
    maxOrderQty: 3,
  }),
  'Coca-Cola — 750ml': foodProduct({
    family: 'beverages',
    brand: 'Coca-Cola',
    netQuantity: '750 ml',
    productType: 'Carbonated soft drink',
    variantLabel: 'Serve Best',
    variant: 'Chilled',
    bestFor: 'Parties, meals, and chilled refreshment',
    special: 'Classic cola flavour in a family-friendly PET bottle',
    description: 'Coca-Cola 750 ml is a classic cola bottle sized for family meals, parties, and chilled refreshment.',
    ingredients: 'Carbonated water, sugar, acidity regulators, natural flavours, and caffeine.',
    allergenInfo: null,
    shelfLife: 'Best before pack date',
    storageInstructions: 'Store in a cool, dry place and serve chilled.',
    packType: 'PET bottle',
    nutritionInfo: {
      'Energy (kcal)': '42',
      Carbohydrate: '10.6 g',
      Sugar: '10.6 g',
      Sodium: '11 mg',
      Caffeine: '10 mg',
    },
    salePrice: 36,
    avgRating: 4.4,
    ratingCount: 196,
    totalSold: 588,
    tags: ['party-pack', 'refreshment'],
    reviewLead: 'Good fizz and the bottle size is handy for family meals',
    orderQty: 2,
    maxOrderQty: 6,
  }),
  'Dove Soap — 100g': essentialProduct({
    family: 'personal',
    brand: 'Dove',
    netQuantity: '100 g',
    productType: 'Moisturising beauty bar',
    variantLabel: 'Skin Type',
    variant: 'Normal to dry skin',
    bestFor: 'Daily bathing and gentle cleansing',
    special: 'Cream beauty bar with a soft, moisturising feel',
    description: 'Dove Soap is a gentle everyday beauty bar designed for mild cleansing and a soft skin feel.',
    ingredients: 'Soap base, moisturising cream, fragrance, and approved cleansing ingredients.',
    allergenInfo: null,
    shelfLife: '24 months',
    storageInstructions: 'Store in a cool, dry place and allow the bar to dry between uses.',
    packType: 'Single wrapped bar',
    salePrice: 49,
    avgRating: 4.7,
    ratingCount: 158,
    totalSold: 492,
    tags: ['personal-care', 'gentle-clean'],
    reviewLead: 'Leaves skin soft and the bar lasts well between baths',
    maxOrderQty: 6,
  }),
  'Everest Turmeric — 100g': foodProduct({
    family: 'spices',
    brand: 'Everest',
    netQuantity: '100 g',
    productType: 'Turmeric powder',
    variantLabel: 'Spice Profile',
    variant: 'Bright colour and daily use',
    bestFor: 'Curries, marinades, and everyday seasoning',
    special: 'Bold yellow turmeric powder from a trusted spice brand',
    description: 'Everest Turmeric adds rich colour and balanced aroma to daily Indian cooking.',
    ingredients: '100% turmeric powder.',
    allergenInfo: null,
    shelfLife: '9 months',
    storageInstructions: 'Store in a dry, airtight container away from moisture.',
    packType: 'Printed spice carton',
    nutritionInfo: {
      'Energy (kcal)': '312',
      Protein: '9.7 g',
      Carbohydrate: '67 g',
      Fat: '3.3 g',
      Fibre: '22 g',
    },
    salePrice: 42,
    avgRating: 4.5,
    ratingCount: 102,
    totalSold: 286,
    tags: ['spice-rack'],
    reviewLead: 'Good colour and aroma for regular home cooking',
  }),
  'Farm Eggs — 6 Pack': foodProduct({
    family: 'dairy',
    vendorKey: 'coldChain',
    brand: 'Bakaloo Farm Fresh',
    netQuantity: '6 eggs',
    productType: 'Farm eggs',
    variantLabel: 'Pack Count',
    variant: '6 count tray',
    bestFor: 'Breakfast, baking, and everyday protein',
    special: 'Fresh tray-packed eggs suited for daily kitchen use',
    description: 'Farm Eggs are tray-packed for safe delivery and everyday breakfast, baking, and protein-rich meals.',
    ingredients: 'Eggs.',
    allergenInfo: 'Contains egg.',
    shelfLife: 'Best within 7 days under refrigeration',
    storageInstructions: 'Refrigerate after delivery and handle with care.',
    packType: 'Tray pack',
    nutritionInfo: {
      'Energy (kcal)': '143',
      Protein: '13 g',
      Fat: '10 g',
      Cholesterol: '373 mg',
      'Vitamin D': '2 mcg',
    },
    salePrice: 57,
    avgRating: 4.4,
    ratingCount: 118,
    totalSold: 314,
    tags: ['protein-rich'],
    reviewLead: 'Eggs arrived intact and looked fresh on delivery',
    maxOrderQty: 5,
  }),
  'Fortune Sunflower Oil — 1L': foodProduct({
    family: 'oils',
    brand: 'Fortune',
    netQuantity: '1 L',
    productType: 'Refined sunflower oil',
    variantLabel: 'Cooking Use',
    variant: 'Frying and sautéing',
    bestFor: 'Everyday cooking, frying, and sautéing',
    special: 'Light cooking oil with a clean flavour profile',
    description: 'Fortune Sunflower Oil is a daily kitchen essential for frying, sautéing, and everyday Indian cooking.',
    ingredients: 'Refined sunflower oil.',
    allergenInfo: null,
    shelfLife: '9 months',
    storageInstructions: 'Store tightly sealed in a cool and dry place.',
    packType: '1 L pouch',
    nutritionInfo: {
      'Energy (kcal)': '900',
      Fat: '100 g',
      'Saturated Fat': '11 g',
      'Monounsaturated Fat': '24 g',
      'Polyunsaturated Fat': '65 g',
    },
    salePrice: 138,
    avgRating: 4.4,
    ratingCount: 144,
    totalSold: 412,
    tags: ['kitchen-essential'],
    reviewLead: 'Good everyday oil and the pouch pack is easy to use',
    maxOrderQty: 4,
  }),
  'Haldiram Aloo Bhujia — 200g': foodProduct({
    family: 'snacks',
    brand: 'Haldiram',
    netQuantity: '200 g',
    productType: 'Savory namkeen',
    variantLabel: 'Flavour',
    variant: 'Aloo bhujia',
    bestFor: 'Tea-time snacking and crunchy toppings',
    special: 'Classic crispy namkeen with familiar Haldiram taste',
    description: 'Haldiram Aloo Bhujia is a crunchy namkeen for tea-time snacking and topping chaats and sandwiches.',
    ingredients: 'Potato, gram flour, edible oil, spices, and seasoning.',
    allergenInfo: 'Contains pulses. Packed in a facility handling peanuts.',
    shelfLife: '6 months',
    storageInstructions: 'Store airtight after opening for best crunch.',
    packType: 'Stand-up snack pouch',
    nutritionInfo: {
      'Energy (kcal)': '547',
      Protein: '8.0 g',
      Carbohydrate: '46 g',
      Fat: '36 g',
      Sodium: '640 mg',
    },
    salePrice: 54,
    avgRating: 4.5,
    ratingCount: 176,
    totalSold: 521,
    tags: ['snack-time'],
    reviewLead: 'Fresh crunchy pack and goes well with evening tea',
  }),
  'Head & Shoulders Shampoo — 340ml': essentialProduct({
    family: 'personal',
    brand: 'Head & Shoulders',
    netQuantity: '340 ml',
    productType: 'Anti-dandruff shampoo',
    variantLabel: 'Hair Concern',
    variant: 'Dandruff control',
    bestFor: 'Daily scalp cleansing and dandruff care',
    special: 'Anti-dandruff shampoo with a clean, refreshing wash feel',
    description: 'Head & Shoulders Shampoo is a dependable anti-dandruff care product for regular scalp cleansing and flake control.',
    ingredients: 'Water, cleansing base, fragrance, conditioners, and anti-dandruff active ingredients.',
    allergenInfo: null,
    shelfLife: '24 months',
    storageInstructions: 'Store tightly capped away from direct sunlight.',
    packType: 'Bottle pack',
    salePrice: 299,
    avgRating: 4.5,
    ratingCount: 138,
    totalSold: 388,
    tags: ['hair-care', 'anti-dandruff'],
    reviewLead: 'Scalp feels cleaner and it helps keep dandruff under control',
    maxOrderQty: 4,
  }),
  'ITC Aashirvaad Paratha — 5 Pack': foodProduct({
    family: 'frozen',
    vendorKey: 'coldChain',
    brand: 'Aashirvaad',
    netQuantity: '5 pieces',
    productType: 'Frozen paratha',
    variantLabel: 'Preparation',
    variant: 'Ready to cook',
    bestFor: 'Quick breakfasts and freezer-friendly meals',
    special: 'Frozen layered parathas for fast family meals',
    description: 'Aashirvaad Paratha is a freezer staple for quick breakfasts, tiffins, and fast weeknight meals.',
    ingredients: 'Whole wheat flour, edible oil, salt, and permitted conditioners.',
    allergenInfo: 'Contains wheat (gluten).',
    shelfLife: '9 months frozen',
    storageInstructions: 'Keep frozen and cook directly from frozen on a hot tawa.',
    packType: 'Frozen pouch',
    nutritionInfo: {
      'Energy (kcal)': '289',
      Protein: '6.3 g',
      Carbohydrate: '36 g',
      Fat: '12 g',
      Sodium: '410 mg',
    },
    salePrice: 79,
    avgRating: 4.3,
    ratingCount: 116,
    totalSold: 309,
    tags: ['quick-meal', 'freezer-staple'],
    reviewLead: 'Convenient for busy mornings and cooks evenly on the tawa',
  }),
  'India Gate Basmati — 5kg': foodProduct({
    family: 'staples',
    brand: 'India Gate',
    netQuantity: '5 kg',
    productType: 'Basmati rice',
    variantLabel: 'Grain Type',
    variant: 'Long grain aromatic rice',
    bestFor: 'Pulao, biryani, and special family meals',
    special: 'Long-grain basmati with a pleasant aroma and fluffy texture',
    description: 'India Gate Basmati Rice is a premium long-grain rice suited for biryani, pulao, and festive home cooking.',
    ingredients: '100% basmati rice.',
    allergenInfo: null,
    shelfLife: '12 months',
    storageInstructions: 'Store in an airtight container away from moisture.',
    packType: '5 kg bag',
    nutritionInfo: {
      'Energy (kcal)': '356',
      Protein: '7.3 g',
      Carbohydrate: '79 g',
      Fat: '0.9 g',
      Fibre: '1.2 g',
    },
    salePrice: 489,
    avgRating: 4.7,
    ratingCount: 214,
    totalSold: 639,
    tags: ['premium-rice', 'family-pack'],
    reviewLead: 'Good aroma and grains cook long and separate',
  }),
  "Lay's Classic Salted — 90g": foodProduct({
    family: 'snacks',
    brand: "Lay's",
    netQuantity: '90 g',
    productType: 'Potato chips',
    variantLabel: 'Flavour',
    variant: 'Classic salted',
    bestFor: 'Quick snacking and party bowls',
    special: 'Classic salted chips with light seasoning and crunch',
    description: "Lay's Classic Salted is a crunchy potato chip pack for quick snacking, party bowls, and lunch-box treats.",
    ingredients: 'Potatoes, edible vegetable oil, and iodised salt.',
    allergenInfo: 'Packed in a facility that may handle milk and soy.',
    shelfLife: '4 months',
    storageInstructions: 'Store in a cool, dry place and reseal after opening.',
    packType: 'Nitrogen flushed snack pack',
    nutritionInfo: {
      'Energy (kcal)': '536',
      Protein: '6.6 g',
      Carbohydrate: '53 g',
      Fat: '34 g',
      Sodium: '525 mg',
    },
    salePrice: 18,
    avgRating: 4.4,
    ratingCount: 188,
    totalSold: 564,
    tags: ['snack-time', 'party-pack'],
    reviewLead: 'Crunchy chips and the classic salted taste stays consistent',
    orderQty: 2,
    maxOrderQty: 8,
  }),
  'Lizol Floor Cleaner — 500ml': essentialProduct({
    family: 'household',
    brand: 'Lizol',
    netQuantity: '500 ml',
    productType: 'Disinfectant floor cleaner',
    variantLabel: 'Use Case',
    variant: 'Floor and surface cleaning',
    bestFor: 'Daily mopping and fresh-smelling floors',
    special: 'Daily cleaning liquid for hygienic and fresh-smelling floors',
    description: 'Lizol Floor Cleaner is a daily home-care liquid for mopping floors and refreshing indoor surfaces.',
    ingredients: 'Cleaning surfactants, fragrance, colour, and approved disinfecting agents.',
    allergenInfo: null,
    shelfLife: '24 months',
    storageInstructions: 'Keep tightly capped and store away from food items and direct sunlight.',
    packType: 'Bottle pack',
    salePrice: 99,
    avgRating: 4.4,
    ratingCount: 132,
    totalSold: 341,
    tags: ['home-cleaning'],
    reviewLead: 'Cleans well and leaves a pleasant floor-cleaner fragrance',
    maxOrderQty: 4,
  }),
  'MDH Garam Masala — 100g': foodProduct({
    family: 'spices',
    brand: 'MDH',
    netQuantity: '100 g',
    productType: 'Garam masala blend',
    variantLabel: 'Spice Blend',
    variant: 'Finishing masala',
    bestFor: 'Curries, gravies, and aromatic finishing',
    special: 'Aromatic masala blend for North Indian gravies and curries',
    description: 'MDH Garam Masala is a versatile aromatic blend for finishing gravies, curries, and rice dishes.',
    ingredients: 'Mixed whole spices ground into a fine masala blend.',
    allergenInfo: null,
    shelfLife: '9 months',
    storageInstructions: 'Store airtight in a cool, dry place.',
    packType: 'Masala carton',
    nutritionInfo: {
      'Energy (kcal)': '292',
      Protein: '10 g',
      Carbohydrate: '43 g',
      Fat: '12 g',
      Fibre: '18 g',
    },
    salePrice: 69,
    avgRating: 4.5,
    ratingCount: 114,
    totalSold: 278,
    tags: ['spice-rack'],
    reviewLead: 'Strong aroma and good flavour in gravies and pulao',
  }),
  'Multigrain Bread': foodProduct({
    family: 'bakery',
    vendorKey: 'coldChain',
    brand: 'Britannia',
    netQuantity: '400 g',
    productType: 'Multigrain bread',
    variantLabel: 'Loaf Type',
    variant: 'Fibre-rich loaf',
    bestFor: 'Breakfast toast and wholesome sandwiches',
    special: 'Soft multigrain loaf with a fibre-forward everyday profile',
    description: 'Multigrain Bread is a wholesome loaf for toast, sandwiches, and balanced everyday breakfasts.',
    ingredients: 'Wheat flour, multigrain blend, yeast, edible oil, and permitted improvers.',
    allergenInfo: 'Contains wheat and may contain milk and soy.',
    shelfLife: '3-5 days',
    storageInstructions: 'Keep sealed in a cool, dry place and consume within the pack period.',
    packType: 'Sliced loaf pack',
    nutritionInfo: {
      'Energy (kcal)': '252',
      Protein: '9.5 g',
      Carbohydrate: '43 g',
      Fat: '4.5 g',
      Fibre: '6 g',
    },
    salePrice: 49,
    avgRating: 4.2,
    ratingCount: 92,
    totalSold: 214,
    tags: ['breakfast', 'fiber-rich'],
    reviewLead: 'Soft loaf and a good option for quick healthy sandwiches',
    maxOrderQty: 4,
  }),
  'Nescafé Classic — 100g': foodProduct({
    family: 'beverages',
    brand: 'Nescafe',
    netQuantity: '100 g',
    productType: 'Instant coffee',
    variantLabel: 'Roast Profile',
    variant: 'Medium-dark roast',
    bestFor: 'Hot coffee, cold coffee, and quick brews',
    special: 'Bold instant coffee with a familiar aroma and full-bodied cup',
    description: 'Nescafe Classic is a pantry-ready instant coffee for quick morning brews and easy cold coffee prep.',
    ingredients: '100% coffee beans.',
    allergenInfo: null,
    shelfLife: '18 months',
    storageInstructions: 'Keep jar airtight and use a dry spoon.',
    packType: 'Glass jar',
    nutritionInfo: {
      'Energy (kcal)': '353',
      Protein: '15 g',
      Carbohydrate: '48 g',
      Fat: '1 g',
      Sodium: '80 mg',
    },
    salePrice: 279,
    avgRating: 4.6,
    ratingCount: 146,
    totalSold: 384,
    tags: ['morning-brew'],
    reviewLead: 'Strong aroma and easy to make for a quick morning coffee',
  }),
  Onion: freshProduct({
    brand: 'Bakaloo Fresh',
    netQuantity: '1 kg',
    productType: 'Red onion',
    variantLabel: 'Source',
    variant: 'Sorted daily stock',
    bestFor: 'Curries, gravies, salads, and tadka',
    special: 'Firm bulbs selected for daily kitchen use',
    description: 'Red onions sorted for firmness and everyday home cooking, from curries to salads.',
    shelfLife: '7-10 days in a cool dry place',
    storageInstructions: 'Store in a cool, dry, and ventilated place away from moisture.',
    packType: 'Open weight produce',
    nutritionInfo: {
      'Energy (kcal)': '40',
      Fibre: '1.7 g',
      Carbohydrate: '9.3 g',
      'Vitamin C': '7.4 mg',
      Folate: '19 mcg',
    },
    salePrice: null,
    avgRating: 4.2,
    ratingCount: 96,
    totalSold: 275,
    tags: ['fresh', 'kitchen-essential'],
    reviewLead: 'Good-sized onions and useful for everyday cooking',
  }),
  'Pampers Diapers — Medium 20 Pack': essentialProduct({
    family: 'baby',
    brand: 'Pampers',
    netQuantity: '20 diapers',
    productType: 'Baby diapers',
    variantLabel: 'Size',
    variant: 'Medium (6-11 kg)',
    bestFor: 'Day and night leak protection',
    special: 'Soft diaper pants with breathable comfort and leak-lock design',
    description: 'Pampers Medium Diapers are sized for babies in the 6-11 kg range with soft comfort and dependable absorbency.',
    ingredients: 'Absorbent core, soft non-woven fabric, waistband, and fastening materials.',
    allergenInfo: null,
    shelfLife: '36 months',
    storageInstructions: 'Store in a cool, dry place away from moisture.',
    packType: 'Soft carry pack',
    salePrice: 499,
    avgRating: 4.7,
    ratingCount: 264,
    totalSold: 688,
    tags: ['baby-care', 'best-seller'],
    reviewLead: 'Comfortable fit and the absorbency lasts well overnight',
    maxOrderQty: 3,
    returnPolicy: '7_day',
  }),
  'Paneer — 200g': foodProduct({
    family: 'dairy',
    vendorKey: 'coldChain',
    brand: 'Amul',
    netQuantity: '200 g',
    productType: 'Fresh paneer',
    variantLabel: 'Texture',
    variant: 'Soft and cube-friendly',
    bestFor: 'Curries, bhurji, tikka, and sandwiches',
    special: 'Soft paneer with a fresh dairy taste for versatile cooking',
    description: 'Fresh paneer packed for curries, tikkas, bhurji, and quick protein-rich meals.',
    ingredients: 'Milk solids and acidity regulator.',
    allergenInfo: 'Contains milk.',
    shelfLife: 'Best before pack date under refrigeration',
    storageInstructions: 'Keep refrigerated and use soon after opening.',
    packType: 'Vacuum pack',
    nutritionInfo: {
      'Energy (kcal)': '265',
      Protein: '18 g',
      Carbohydrate: '4 g',
      Fat: '20 g',
      Calcium: '420 mg',
    },
    salePrice: 79,
    avgRating: 4.4,
    ratingCount: 104,
    totalSold: 268,
    tags: ['protein-rich', 'daily-cooking'],
    reviewLead: 'Soft paneer cubes and good freshness for curries',
  }),
  'Parle-G Biscuits — 250g': foodProduct({
    family: 'snacks',
    brand: 'Parle',
    netQuantity: '250 g',
    productType: 'Glucose biscuits',
    variantLabel: 'Pack Type',
    variant: 'Family value pack',
    bestFor: 'Tea time, quick snacks, and tiffin',
    special: 'Classic glucose biscuits with familiar taste and value sizing',
    description: 'Parle-G is a classic glucose biscuit pack made for tea-time snacking, tiffins, and quick bite moments.',
    ingredients: 'Wheat flour, sugar, edible vegetable oil, milk solids, and raising agents.',
    allergenInfo: 'Contains wheat and milk.',
    shelfLife: '6 months',
    storageInstructions: 'Store in an airtight container after opening.',
    packType: 'Value pouch',
    nutritionInfo: {
      'Energy (kcal)': '450',
      Protein: '7 g',
      Carbohydrate: '72 g',
      Fat: '14 g',
      Sugar: '23 g',
    },
    salePrice: 21,
    avgRating: 4.5,
    ratingCount: 226,
    totalSold: 712,
    tags: ['tea-time', 'value-pack'],
    reviewLead: 'Fresh biscuits and the value pack is good for the family',
    orderQty: 2,
    maxOrderQty: 8,
  }),
  Potato: freshProduct({
    brand: 'Bakaloo Fresh',
    netQuantity: '1 kg',
    productType: 'Table potato',
    variantLabel: 'Usage',
    variant: 'Boil, fry, mash',
    bestFor: 'Curries, fries, mash, and daily cooking',
    special: 'Clean-sorted potatoes suited for regular kitchen prep',
    description: 'Table potatoes sorted for consistent kitchen use across curries, fries, mash, and paratha fillings.',
    shelfLife: '7-10 days in a cool dry place',
    storageInstructions: 'Store away from sunlight in a cool and ventilated area.',
    packType: 'Open weight produce',
    nutritionInfo: {
      'Energy (kcal)': '77',
      Fibre: '2.2 g',
      Carbohydrate: '17 g',
      Potassium: '425 mg',
      'Vitamin C': '19.7 mg',
    },
    salePrice: 28,
    avgRating: 4.3,
    ratingCount: 112,
    totalSold: 318,
    tags: ['fresh', 'kitchen-essential'],
    reviewLead: 'Clean potatoes and good for both curries and fries',
  }),
  'Real Mango Juice — 1L': foodProduct({
    family: 'beverages',
    brand: 'Real',
    netQuantity: '1 L',
    productType: 'Mango beverage',
    variantLabel: 'Pack Type',
    variant: 'Family tetra pack',
    bestFor: 'Breakfast pours and chilled family servings',
    special: 'Ready-to-serve mango beverage with a familiar fruit taste',
    description: 'Real Mango Juice is a ready-to-serve family beverage for chilled pours, breakfast servings, and easy refreshment.',
    ingredients: 'Water, mango pulp, sugar, acidity regulators, and added vitamin C.',
    allergenInfo: null,
    shelfLife: '6 months unopened',
    storageInstructions: 'Store in a cool place and refrigerate after opening.',
    packType: 'Tetra pack',
    nutritionInfo: {
      'Energy (kcal)': '56',
      Carbohydrate: '13.5 g',
      Sugar: '12.5 g',
      'Vitamin C': '20 mg',
      Sodium: '20 mg',
    },
    salePrice: 92,
    avgRating: 4.4,
    ratingCount: 156,
    totalSold: 441,
    tags: ['family-pack', 'refreshment'],
    reviewLead: 'Good mango taste and easy family-size breakfast pack',
    maxOrderQty: 5,
  }),
  'Red Chilli Powder — 200g': foodProduct({
    family: 'spices',
    brand: 'Bakaloo Select',
    netQuantity: '200 g',
    productType: 'Red chilli powder',
    variantLabel: 'Heat Level',
    variant: 'Medium hot',
    bestFor: 'Curries, tadka, and spice blends',
    special: 'Vibrant chilli powder with colour and balanced heat',
    description: 'Red Chilli Powder adds colour, depth, and heat to curries, tadka, and daily masala prep.',
    ingredients: '100% ground red chillies.',
    allergenInfo: null,
    shelfLife: '9 months',
    storageInstructions: 'Store airtight away from moisture and direct heat.',
    packType: 'Stand-up spice pouch',
    nutritionInfo: {
      'Energy (kcal)': '318',
      Protein: '12 g',
      Carbohydrate: '56 g',
      Fat: '17 g',
      Fibre: '27 g',
    },
    salePrice: 59,
    avgRating: 4.3,
    ratingCount: 84,
    totalSold: 211,
    tags: ['spice-rack'],
    reviewLead: 'Good colour and the spice level works well for regular cooking',
  }),
  'Spinach (Palak)': freshProduct({
    brand: 'Bakaloo Fresh',
    netQuantity: '250 g',
    productType: 'Leafy spinach',
    variantLabel: 'Cut Type',
    variant: 'Leafy bunch',
    bestFor: 'Dal, sabzi, smoothies, and soups',
    special: 'Leafy green bunch sourced for same-day fresh use',
    description: 'Fresh spinach bunches suitable for dal, sabzi, soups, and green smoothies.',
    shelfLife: '1-2 days refrigerated',
    storageInstructions: 'Refrigerate and use promptly after washing and sorting.',
    packType: 'Fresh leafy bunch',
    nutritionInfo: {
      'Energy (kcal)': '23',
      Protein: '2.9 g',
      Fibre: '2.2 g',
      Iron: '2.7 mg',
      Folate: '194 mcg',
    },
    salePrice: null,
    avgRating: 4.1,
    ratingCount: 54,
    totalSold: 132,
    tags: ['fresh', 'leafy-greens'],
    reviewLead: 'Fresh leaves and works well for quick palak recipes',
  }),
  'Surf Excel Easy Wash — 1.5kg': essentialProduct({
    family: 'household',
    brand: 'Surf Excel',
    netQuantity: '1.5 kg',
    productType: 'Detergent powder',
    variantLabel: 'Wash Type',
    variant: 'Bucket and machine wash',
    bestFor: 'Regular laundry and stain removal',
    special: 'Detergent powder for everyday family laundry loads',
    description: 'Surf Excel Easy Wash detergent powder is a family laundry staple for regular wash cycles and daily stain removal.',
    ingredients: 'Cleaning agents, builders, optical brighteners, fragrance, and enzymes.',
    allergenInfo: null,
    shelfLife: '24 months',
    storageInstructions: 'Keep sealed and store in a dry area away from moisture.',
    packType: 'Resealable detergent pouch',
    salePrice: 199,
    avgRating: 4.5,
    ratingCount: 168,
    totalSold: 454,
    tags: ['laundry-care'],
    reviewLead: 'Cleans daily clothes well and the larger pouch lasts longer',
    maxOrderQty: 4,
  }),
  'Tata Tea Gold — 500g': foodProduct({
    family: 'beverages',
    brand: 'Tata Tea',
    netQuantity: '500 g',
    productType: 'Black tea',
    variantLabel: 'Blend',
    variant: 'Premium leaf blend',
    bestFor: 'Strong milk tea and family tea breaks',
    special: 'Aromatic tea blend for a rich everyday cup',
    description: 'Tata Tea Gold is a premium household tea blend for strong milk tea and aromatic family brews.',
    ingredients: 'Black tea leaves.',
    allergenInfo: null,
    shelfLife: '12 months',
    storageInstructions: 'Store airtight away from moisture and strong odours.',
    packType: 'Tea pouch pack',
    nutritionInfo: {
      'Energy (kcal)': '1',
      Protein: '0 g',
      Carbohydrate: '0 g',
      Fat: '0 g',
      Sugar: '0 g',
    },
    salePrice: 249,
    avgRating: 4.5,
    ratingCount: 128,
    totalSold: 359,
    tags: ['tea-time', 'family-pack'],
    reviewLead: 'Nice aroma and gives a strong cup with milk',
  }),
  'Tomato — Local': freshProduct({
    brand: 'Bakaloo Fresh',
    netQuantity: '1 kg',
    productType: 'Local tomato',
    variantLabel: 'Use',
    variant: 'Cooking tomato',
    bestFor: 'Curries, salads, gravies, and chutneys',
    special: 'Juicy local tomatoes sorted for daily home cooking',
    description: 'Local tomatoes picked for kitchen-friendly ripeness, curries, and fresh everyday gravies.',
    shelfLife: '2-4 days',
    storageInstructions: 'Keep at room temperature and refrigerate when fully ripe.',
    packType: 'Open weight produce',
    nutritionInfo: {
      'Energy (kcal)': '18',
      Fibre: '1.2 g',
      Carbohydrate: '3.9 g',
      'Vitamin C': '13.7 mg',
      Lycopene: '2573 mcg',
    },
    salePrice: 36,
    avgRating: 4.2,
    ratingCount: 88,
    totalSold: 241,
    tags: ['fresh', 'daily-cooking'],
    reviewLead: 'Juicy tomatoes and the quality is good for curries',
  }),
  'Toor Dal — 1kg': foodProduct({
    family: 'staples',
    brand: 'Tata Sampann',
    netQuantity: '1 kg',
    productType: 'Toor dal',
    variantLabel: 'Dal Type',
    variant: 'Split pigeon peas',
    bestFor: 'Dal, khichdi, and everyday family meals',
    special: 'Clean-sorted toor dal for regular home cooking',
    description: 'Toor Dal is a pantry essential cleaned and packed for dal, khichdi, and protein-rich daily meals.',
    ingredients: 'Split pigeon peas (toor dal).',
    allergenInfo: null,
    shelfLife: '12 months',
    storageInstructions: 'Store in an airtight container in a dry place.',
    packType: '1 kg staple pouch',
    nutritionInfo: {
      'Energy (kcal)': '335',
      Protein: '22 g',
      Carbohydrate: '58 g',
      Fat: '1.7 g',
      Fibre: '15 g',
    },
    salePrice: 149,
    avgRating: 4.4,
    ratingCount: 118,
    totalSold: 327,
    tags: ['protein-rich', 'daily-staple'],
    reviewLead: 'Dal cooks well and the grains looked clean in the pack',
  }),
}

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

PRODUCT_CONFIGS['Banan a — Robusta']

PRODUCT_CONFIGS['Banana — Robusta'] = PRODUCT_CONFIGS['Banana — Robusta'] || PRODUCT_CONFIGS['Banana — Robusta']

Object.assign(PRODUCT_CONFIGS, {
  'Amul Butter — 100g': PRODUCT_CONFIGS['Amul Butter — 100g'],
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Amul Butter — 100g': PRODUCT_CONFIGS['Amul Butter — 100g'],
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Amul Butter — 100g': PRODUCT_CONFIGS['Amul Butter — 100g'],
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Amul Butter — 100g': PRODUCT_CONFIGS['Amul Butter — 100g'],
  'Fortune Sunflower Oil — 1L': PRODUCT_CONFIGS['Fortune Sunflower Oil — 1L'],
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

PRODUCT_CONFIGS['Banan a — Robusta']

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

PRODUCT_CONFIGS['Multigrain Bread'] = PRODUCT_CONFIGS['Multigrain Bread']
PRODUCT_CONFIGS['Nescafé Classic — 100g'] = PRODUCT_CONFIGS['Nescafé Classic — 100g']

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

PRODUCT_CONFIGS['Banan a — Robusta']

Object.assign(PRODUCT_CONFIGS, {
  'Pampers Diapers — Medium 20 Pack': PRODUCT_CONFIGS['Pampers Diapers — Medium 20 Pack'],
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

PRODUCT_CONFIGS['Banan a — Robusta']

PRODUCT_CONFIGS['Banana — Robusta'] = freshProduct({
  brand: 'Bakaloo Fresh',
  netQuantity: '1 kg',
  productType: 'Robusta banana',
  variantLabel: 'Ripeness',
  variant: 'Ready to ripen',
  bestFor: 'Breakfast, smoothies, and quick snacks',
  special: 'Naturally sweet bananas sourced for everyday snacking',
  description: 'Robusta bananas packed for daily snacking, breakfast bowls, and smoothies with a naturally sweet profile.',
  shelfLife: '2-4 days at room temperature',
  storageInstructions: 'Keep in a cool place and refrigerate only after ripening.',
  packType: 'Open weight produce',
  nutritionInfo: {
    'Energy (kcal)': '89',
    Fibre: '2.6 g',
    Carbohydrate: '22.8 g',
    Potassium: '358 mg',
    'Vitamin B6': '0.4 mg',
  },
  salePrice: null,
  avgRating: 4.4,
  ratingCount: 166,
  totalSold: 486,
  tags: ['fresh', 'daily-fruit'],
  reviewLead: 'Good sweetness and the bananas ripened evenly',
  orderQty: 1,
})

PRODUCT_CONFIGS['Dove Soap — 100g'] = PRODUCT_CONFIGS['Dove Soap — 100g']
PRODUCT_CONFIGS['Fortune Sunflower Oil — 1L'] = PRODUCT_CONFIGS['Fortune Sunflower Oil — 1L']

Object.assign(PRODUCT_CONFIGS, {
  'Paneer — 200g': PRODUCT_CONFIGS['Paneer — 200g'],
  'Parle-G Biscuits — 250g': PRODUCT_CONFIGS['Parle-G Biscuits — 250g'],
  Potato: PRODUCT_CONFIGS.Potato,
  'Real Mango Juice — 1L': PRODUCT_CONFIGS['Real Mango Juice — 1L'],
  'Red Chilli Powder — 200g': PRODUCT_CONFIGS['Red Chilli Powder — 200g'],
  'Spinach (Palak)': PRODUCT_CONFIGS['Spinach (Palak)'],
  'Surf Excel Easy Wash — 1.5kg': PRODUCT_CONFIGS['Surf Excel Easy Wash — 1.5kg'],
  'Tata Tea Gold — 500g': PRODUCT_CONFIGS['Tata Tea Gold — 500g'],
  'Tomato — Local': PRODUCT_CONFIGS['Tomato — Local'],
  'Toor Dal — 1kg': PRODUCT_CONFIGS['Toor Dal — 1kg'],
  'Everest Turmeric — 100g': PRODUCT_CONFIGS['Everest Turmeric — 100g'],
  'Farm Eggs — 6 Pack': PRODUCT_CONFIGS['Farm Eggs — 6 Pack'],
  'Britannia White Bread': PRODUCT_CONFIGS['Britannia White Bread'],
  'Cerelac — Stage 1 — 300g': PRODUCT_CONFIGS['Cerelac — Stage 1 — 300g'],
})

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

PRODUCT_CONFIGS['Coca-Cola — 750ml'] = PRODUCT_CONFIGS['Coca-Cola — 750ml']

Object.assign(PRODUCT_CONFIGS, {
  'Banan a — Robusta': undefined,
})

PRODUCT_CONFIGS['Nescafé Classic — 100g'] = foodProduct({
  family: 'beverages',
  brand: 'Nescafe',
  netQuantity: '100 g',
  productType: 'Instant coffee',
  variantLabel: 'Roast Profile',
  variant: 'Medium-dark roast',
  bestFor: 'Hot coffee, cold coffee, and quick brews',
  special: 'Bold instant coffee with a familiar aroma and full-bodied cup',
  description: 'Nescafe Classic is a pantry-ready instant coffee for quick morning brews and easy cold coffee prep.',
  ingredients: '100% coffee beans.',
  allergenInfo: null,
  shelfLife: '18 months',
  storageInstructions: 'Keep jar airtight and use a dry spoon.',
  packType: 'Glass jar',
  nutritionInfo: {
    'Energy (kcal)': '353',
    Protein: '15 g',
    Carbohydrate: '48 g',
    Fat: '1 g',
    Sodium: '80 mg',
  },
  salePrice: 279,
  avgRating: 4.6,
  ratingCount: 146,
  totalSold: 384,
  tags: ['morning-brew'],
  reviewLead: 'Strong aroma and easy to make for a quick morning coffee',
})

Object.assign(PRODUCT_CONFIGS, {
  'Amul Butter — 100g': PRODUCT_CONFIGS['Amul Butter — 100g'],
  'Amul Ghee — 500ml': PRODUCT_CONFIGS['Amul Ghee — 500ml'],
  'Amul Ice Cream — Vanilla 1L': PRODUCT_CONFIGS['Amul Ice Cream — Vanilla 1L'],
  'Amul Toned Milk — 500ml': PRODUCT_CONFIGS['Amul Toned Milk — 500ml'],
  'Apple — Shimla': PRODUCT_CONFIGS['Apple — Shimla'],
  'Banana — Robusta': PRODUCT_CONFIGS['Banana — Robusta'],
  'Britannia White Bread': PRODUCT_CONFIGS['Britannia White Bread'],
  'Cerelac — Stage 1 — 300g': PRODUCT_CONFIGS['Cerelac — Stage 1 — 300g'],
  'Coca-Cola — 750ml': PRODUCT_CONFIGS['Coca-Cola — 750ml'],
  'Dove Soap — 100g': PRODUCT_CONFIGS['Dove Soap — 100g'],
  'Everest Turmeric — 100g': PRODUCT_CONFIGS['Everest Turmeric — 100g'],
  'Farm Eggs — 6 Pack': PRODUCT_CONFIGS['Farm Eggs — 6 Pack'],
  'Fortune Sunflower Oil — 1L': PRODUCT_CONFIGS['Fortune Sunflower Oil — 1L'],
  'Haldiram Aloo Bhujia — 200g': PRODUCT_CONFIGS['Haldiram Aloo Bhujia — 200g'],
  'Head & Shoulders Shampoo — 340ml': PRODUCT_CONFIGS['Head & Shoulders Shampoo — 340ml'],
  'ITC Aashirvaad Paratha — 5 Pack': PRODUCT_CONFIGS['ITC Aashirvaad Paratha — 5 Pack'],
  'India Gate Basmati — 5kg': PRODUCT_CONFIGS['India Gate Basmati — 5kg'],
  "Lay's Classic Salted — 90g": PRODUCT_CONFIGS["Lay's Classic Salted — 90g"],
  'Lizol Floor Cleaner — 500ml': PRODUCT_CONFIGS['Lizol Floor Cleaner — 500ml'],
  'MDH Garam Masala — 100g': PRODUCT_CONFIGS['MDH Garam Masala — 100g'],
  'Multigrain Bread': PRODUCT_CONFIGS['Multigrain Bread'],
  'Nescafé Classic — 100g': PRODUCT_CONFIGS['Nescafé Classic — 100g'],
  Onion: PRODUCT_CONFIGS.Onion,
  'Pampers Diapers — Medium 20 Pack': PRODUCT_CONFIGS['Pampers Diapers — Medium 20 Pack'],
  'Paneer — 200g': PRODUCT_CONFIGS['Paneer — 200g'],
  'Parle-G Biscuits — 250g': PRODUCT_CONFIGS['Parle-G Biscuits — 250g'],
  Potato: PRODUCT_CONFIGS.Potato,
  'Real Mango Juice — 1L': PRODUCT_CONFIGS['Real Mango Juice — 1L'],
  'Red Chilli Powder — 200g': PRODUCT_CONFIGS['Red Chilli Powder — 200g'],
  'Spinach (Palak)': PRODUCT_CONFIGS['Spinach (Palak)'],
  'Surf Excel Easy Wash — 1.5kg': PRODUCT_CONFIGS['Surf Excel Easy Wash — 1.5kg'],
  'Tata Tea Gold — 500g': PRODUCT_CONFIGS['Tata Tea Gold — 500g'],
  'Tomato — Local': PRODUCT_CONFIGS['Tomato — Local'],
  'Toor Dal — 1kg': PRODUCT_CONFIGS['Toor Dal — 1kg'],
})

function addRemainingConfigs() {
  PRODUCT_CONFIGS['Aashirvaad Atta — 5kg'] = PRODUCT_CONFIGS['Aashirvaad Atta — 5kg']
}

addRemainingConfigs()

function addSupplementalConfigs() {
  PRODUCT_CONFIGS['Banan a — Robusta'] = undefined
}

addSupplementalConfigs()

function ensureAllConfigsPresent(productNames) {
  const missing = productNames.filter((name) => !PRODUCT_CONFIGS[name])
  if (missing.length > 0) {
    throw new Error(`Missing enrichment config for: ${missing.join(', ')}`)
  }
}

function paymentMethodFor(index) {
  return ['UPI', 'CARD', 'COD', 'ONLINE'][index % 4]
}

async function upsertDemoCustomerNames(client) {
  for (const customer of DEMO_CUSTOMERS) {
    await client.query(
      `UPDATE users
       SET name = $1
       WHERE id = $2`,
      [customer.name, customer.id]
    )
  }
}

async function clearExistingDemoOrders(client) {
  const { rows } = await client.query(
    `SELECT id
     FROM orders
     WHERE order_number LIKE 'DEMO-PDP-%'
        OR order_number LIKE 'DMP%'`
  )
  const orderIds = rows.map((row) => row.id)
  if (orderIds.length === 0) {
    return { deletedOrders: 0 }
  }

  await client.query('DELETE FROM reviews WHERE order_id = ANY($1::uuid[])', [orderIds])
  await client.query('DELETE FROM order_status_history WHERE order_id = ANY($1::uuid[])', [orderIds])
  await client.query('DELETE FROM order_items WHERE order_id = ANY($1::uuid[])', [orderIds])
  await client.query('DELETE FROM orders WHERE id = ANY($1::uuid[])', [orderIds])

  return { deletedOrders: orderIds.length }
}

async function updateProductRow(client, product, config, index) {
  const payload = {
    highlights: buildHighlights(config),
    attributes: buildAttributes(config),
    vendor: VENDORS[config.vendorKey],
    description: buildDescription(product.name, config),
  }

  await client.query(
    `UPDATE products
     SET highlights = $2::jsonb,
         attributes = $3::jsonb,
         vendor_name = $4,
         vendor_address = $5,
         vendor_fssai = $6,
         description = $7,
         updated_at = NOW()
     WHERE id = $1`,
    [
      product.id,
      JSON.stringify(payload.highlights),
      JSON.stringify(payload.attributes),
      payload.vendor.name,
      payload.vendor.address,
      payload.vendor.fssai,
      payload.description,
    ]
  )
}

async function createDemoOrder(client, product, config, index, variantIndex) {
  const customer = DEMO_CUSTOMERS[(index + variantIndex) % DEMO_CUSTOMERS.length]
  const quantity = variantIndex === 0 ? config.orderQty : Math.min(config.orderQty + 1, config.maxOrderQty)
  const unitPrice = config.salePrice && Number(config.salePrice) < Number(product.price)
    ? Number(config.salePrice)
    : Number(product.price)
  const subtotal = unitPrice * quantity
  const discountAmount = Math.max(0, (Number(product.price) - unitPrice) * quantity)
  const deliveryFee = config.family === 'fresh' ? 20 : 25
  const platformFee = 5
  const totalAmount = subtotal + deliveryFee + platformFee
  const times = buildOrderTimestamps(index, variantIndex)
  const orderNumber = `DMP${String(index + 1).padStart(2, '0')}${variantIndex + 1}${product.id.replace(/-/g, '').slice(0, 10)}`
  const items = [
    {
      productId: product.id,
      name: product.name,
      price: unitPrice,
      quantity,
      unit: product.unit,
      total: subtotal,
    },
  ]

  const { rows } = await client.query(
    `INSERT INTO orders (
       order_number, user_id, status, items, subtotal, discount_amount,
       delivery_fee, platform_fee, tax_amount, total_amount,
       payment_method, payment_status, coupon_code, delivery_address,
       delivery_notes, estimated_delivery, delivered_at
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)
     RETURNING id`,
    [
      orderNumber,
      customer.id,
      'DELIVERED',
      JSON.stringify(items),
      subtotal,
      discountAmount,
      deliveryFee,
      platformFee,
      0,
      totalAmount,
      paymentMethodFor(index + variantIndex),
      'PAID',
      null,
      JSON.stringify(buildAddress(index + variantIndex, customer)),
      'Demo delivered order generated for richer product detail screens.',
      times.estimatedDelivery,
      times.deliveredAt,
    ]
  )

  const orderId = rows[0].id

  await client.query(
    `INSERT INTO order_items (order_id, product_id, name, price, quantity, unit, total)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [orderId, product.id, product.name, unitPrice, quantity, product.unit, subtotal]
  )

  await client.query(
    `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, note, changed_at)
     VALUES
       ($1, NULL, 'PENDING', $2, 'Order created for demo data', $3),
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

async function createReview(client, productId, orderInfo, config, reviewIndex) {
  const comments = buildReviewComments(productId, config)
  const ratings = buildReviewRatings(config)

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

async function seedOrdersAndReviewsForProduct(client, product, config, index) {
  const reviewIterations = config.seedReviewCount ?? 2
  let orders = 0
  let reviews = 0

  for (let reviewIndex = 0; reviewIndex < reviewIterations; reviewIndex += 1) {
    const orderInfo = await createDemoOrder(client, product, config, index, reviewIndex)
    orders += 1
    await createReview(client, product.id, orderInfo, config, reviewIndex)
    reviews += 1
  }

  return { orders, reviews }
}

async function main() {
  const client = await getClient()
  let updatedProducts = 0

  try {
    await client.query('BEGIN')

    const { rows: products } = await client.query(
      `SELECT p.id, p.name
       FROM products p
       ORDER BY p.name`
    )

    ensureAllConfigsPresent(products.map((product) => product.name))

    for (const [index, product] of products.entries()) {
      const config = PRODUCT_CONFIGS[product.name]
      await updateProductRow(client, product, config, index)
      updatedProducts += 1
    }

    await client.query('COMMIT')
    await cacheDeletePattern('products:*')

    console.log(
      JSON.stringify(
        {
          updatedProducts,
          refreshedFields: ['description', 'highlights', 'attributes', 'vendor_name', 'vendor_address', 'vendor_fssai'],
        },
        null,
        2
      )
    )
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Demo enrichment failed:')
    console.error(error?.stack || error?.message || error)
    process.exitCode = 1
  } finally {
    client.release()
  }
}

main()
