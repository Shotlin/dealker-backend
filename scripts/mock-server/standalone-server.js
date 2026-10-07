import Fastify from 'fastify';
import cors from '@fastify/cors';
import fs from 'fs';
import path from 'path';

// This is a hardcoded/JSON-seeded MOCK API — it never touches Postgres.
// It must never share a port with the real server (src/server.js), or a
// dashboard call could silently return fake data instead of a connection
// error. Defaults to 4599. Binding to the real API's default port (4500)
// requires the explicit MOCK_SERVER=1 env var, so nobody hits it by accident.
const requestedPort = Number(process.env.PORT) || 4599;
if (requestedPort === 4500 && process.env.MOCK_SERVER !== '1') {
  console.error('❌ Refusing to bind port 4500: that is the real backend\'s port.');
  console.error('   This is the MOCK API. Set MOCK_SERVER=1 to force it onto 4500, or unset PORT to use 4599.');
  process.exit(1);
}
const PORT = requestedPort;
const DB_FILE = path.join(process.cwd(), 'standalone-db.json');
const app = Fastify({ logger: true });

app.get('/health', async () => ({
  status: 'ok',
  mode: 'MOCK',
  db: 'none',
  note: 'This is the hardcoded mock API, not the real Postgres-backed server.',
}));

await app.register(cors, {
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Role-Scope', 'X-Warehouse-Scope'],
});

// Seed Database Entities
const defaultDeliveries = [
  { id: 'del-101', riderName: 'Vikram Singh', status: 'En Route', orderNumber: 'MC-2026-8841', cluster: 'South Mumbai FC', lat: 18.922, lng: 72.834, phone: '+91 98200 11223', vehicleNumber: 'MH-01-CV-4421' },
  { id: 'del-102', riderName: 'Ramesh Kumar', status: 'Out for Delivery', orderNumber: 'MC-2026-8842', cluster: 'Bandra West', lat: 19.060, lng: 72.836, phone: '+91 98200 44556', vehicleNumber: 'MH-02-DN-9902' },
  { id: 'del-103', riderName: 'Amit Shah', status: 'At FC Hub', orderNumber: 'MC-2026-8843', cluster: 'North Delhi Hub', lat: 28.704, lng: 77.102, phone: '+91 98100 77889', vehicleNumber: 'DL-01-AB-1234' },
];

const defaultClusters = [
  { id: 'c-1', name: 'Bandra West', count: 4, lat: 19.060, lng: 72.836 },
  { id: 'c-2', name: 'Bellandur', count: 3, lat: 12.926, lng: 77.676 },
  { id: 'c-3', name: 'Civil Lines', count: 2, lat: 28.681, lng: 77.222 },
  { id: 'c-4', name: 'South Mumbai FC', count: 5, lat: 18.922, lng: 72.834 }
];

const defaultOrders = [
  { id: 'ord-1', orderNumber: 'MC-2026-8841', customerName: 'Ananya Sharma', warehouseLocation: 'South Mumbai FC', totalAmount: 1850.00, status: 'In QC', paymentStatus: 'Paid', cuttingEvidenceUrl: '/assets/banner-01-premium-lamb.png', videoModerationStatus: 'Pending', weightVarianceKg: -0.05, lotTraceIds: ['LOT-MEAT-4921'], items: [{ id: 'i-1', productName: 'Premium Goat Curry Cut 1.00kg', category: 'Mutton / Lamb', declaredWeightKg: 1.00, actualWeightKg: 1.045, totalPrice: 1850.00, cutType: 'Curry Cut', lotId: 'LOT-MEAT-4921' }] },
  { id: 'ord-2', orderNumber: 'MC-2026-8842', customerName: 'Rajesh Verma', warehouseLocation: 'North Delhi Hub', totalAmount: 940.00, status: 'Delivered', paymentStatus: 'Paid', cuttingEvidenceUrl: '/assets/banner-02-fresh-poultry.png', videoModerationStatus: 'Approved', weightVarianceKg: 0.02, lotTraceIds: ['LOT-MEAT-8812'], items: [{ id: 'i-2', productName: 'Farm Fresh Chicken Whole 1.2kg', category: 'Poultry', declaredWeightKg: 1.20, actualWeightKg: 1.22, totalPrice: 940.00, cutType: 'Whole Cleaned', lotId: 'LOT-MEAT-8812' }] },
];

const defaultReceipts = [
  { id: 'qc-1', receiptNumber: 'QCR-2026-0912', appointmentId: 'APT-8821', vendorName: 'MeatCraft Farms Ltd.', categoryName: 'Mutton / Lamb', declaredQtyKg: 450.0, measuredQtyKg: 448.2, varianceQtyKg: -1.8, temperatureCelsius: 2.4, temperatureStatus: 'Normal', qcStatus: 'Accepted', inspectorName: 'Sanjay Kumar', receivedAt: '2026-08-07 08:30:00', notes: 'Verified cold-chain compliance.', lotIdCreated: 'LOT-MEAT-4921' },
  { id: 'qc-2', receiptNumber: 'QCR-2026-0915', appointmentId: 'APT-8824', vendorName: 'Baramati Poultry Co.', categoryName: 'Poultry', declaredQtyKg: 800.0, measuredQtyKg: 795.0, varianceQtyKg: -5.0, temperatureCelsius: 3.1, temperatureStatus: 'Normal', qcStatus: 'Quarantined', inspectorName: 'Sanjay Kumar', receivedAt: '2026-08-07 09:15:00', notes: 'Secondary swab pending.', lotIdCreated: null },
  { id: 'qc-3', receiptNumber: 'QCR-2026-0918', appointmentId: 'APT-8829', vendorName: 'Coastal Fisheries Corp.', categoryName: 'Fish & Seafood', declaredQtyKg: 300.0, measuredQtyKg: 290.0, varianceQtyKg: -10.0, temperatureCelsius: 6.8, temperatureStatus: 'Pending QC', inspectorName: 'Sanjay Kumar', receivedAt: '2026-08-07 11:00:00', notes: 'Elevated temperature on dock arrival.', lotIdCreated: null }
];

const defaultInventory = [
  { id: 'lot-1', lotNumber: 'LOT-MEAT-4921', sku: 'SKU-MUT-G01', productName: 'Goat Carcass / Prime Cut', vendorName: 'MeatCraft Farms Ltd.', batchNumber: 'BATCH-2026-88', receivedDate: '2026-08-07', expiryDate: '2026-08-11', availableWeightKg: 448.2, reservedWeightKg: 45.0, pickedWeightKg: 12.5, storageTempCelsius: 2.1, warehouseLocation: 'South Mumbai FC (Cold Bay 3)', status: 'Active', lineage: { vendorId: 'VEN-101', supplyBatchId: 'SB-8821', qcReceiptId: 'QCR-2026-0912', farmOrigin: 'Satara Organic Farms, Maharashtra' } }
];

const defaultVendors = [
  { id: 'VEN-101', companyName: 'MeatCraft Farms Ltd.', category: 'Mutton / Lamb Supply', licenseNumber: 'FSSAI-11522001000994', kycStatus: 'Verified', riskScore: 'Low', totalFulfilledValue: 14500000 },
  { id: 'VEN-102', companyName: 'Baramati Poultry Co-op', category: 'Poultry & Eggs', licenseNumber: 'FSSAI-11522002000881', kycStatus: 'Under Review', riskScore: 'Medium', totalFulfilledValue: 8900000 }
];

const defaultProducts = [
  { id: 'prod-1', name: 'Premium Goat Curry Cut 1.00kg', category: 'Mutton / Lamb', price: 1850, sku: 'SKU-MUT-G01', cutType: 'Curry Cut', storageTemp: '0°C to 4°C', inStock: true },
  { id: 'prod-2', name: 'Farm Fresh Chicken Whole 1.2kg', category: 'Poultry', price: 940, sku: 'SKU-POL-C02', cutType: 'Whole Cleaned', storageTemp: '0°C to 4°C', inStock: true },
  { id: 'prod-3', name: 'Fresh Sea Bass Fillet 500g', category: 'Fish & Seafood', price: 1250, sku: 'SKU-SEA-F03', cutType: 'Fillet', storageTemp: '-2°C to 2°C', inStock: true },
  { id: 'prod-4', name: 'Marinated Lamb Kebabs 400g', category: 'Ready to Cook', price: 650, sku: 'SKU-RTC-K04', cutType: 'Skewers', storageTemp: '0°C to 4°C', inStock: true }
];

const defaultTickets = [
  { id: 'TKT-901', customerName: 'Ananya Sharma', category: 'Temperature Issue', title: 'Packaging Seal Integrity Query', status: 'Open', priority: 'High', orderNumber: 'MC-2026-8841', createdAt: '2026-08-10 12:30', notes: ['Initial customer complaint logged.'] },
  { id: 'TKT-902', customerName: 'Rajesh Verma', category: 'Weight Discrepancy', title: 'Cutting Weight Variance Refund Request', status: 'Open', priority: 'Medium', orderNumber: 'MC-2026-8842', createdAt: '2026-08-09 15:45', notes: [] }
];

const defaultRecalls = [
  { id: 'RCL-2026-01', lotNumber: 'LOT-MEAT-4921', reason: 'Receiving Temperature Spike (6.8°C)', affectedUnits: 45, severity: 'High', status: 'Active', createdAt: '2026-08-07 10:15', notified: false },
  { id: 'RCL-2026-02', lotNumber: 'LOT-MEAT-8812', reason: 'Packaging Seal Inspection Failed', affectedUnits: 20, severity: 'Medium', status: 'Active', createdAt: '2026-08-08 14:20', notified: false }
];

// Load Disk-Backed Persistence or Fallback to Defaults
let db = {
  deliveries: defaultDeliveries,
  clusters: defaultClusters,
  orders: defaultOrders,
  receipts: defaultReceipts,
  inventory: defaultInventory,
  vendors: defaultVendors,
  products: defaultProducts,
  tickets: defaultTickets,
  recalls: defaultRecalls,
};

if (fs.existsSync(DB_FILE)) {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    db = { ...db, ...parsed };
    console.log(`📁 Loaded persistent disk database state from ${DB_FILE}`);
  } catch (err) {
    console.warn(`Failed to parse ${DB_FILE}, using default initial state.`, err);
  }
} else {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  console.log(`📁 Created new disk database file at ${DB_FILE}`);
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('Failed to save disk database state:', err);
  }
}

const mockFinanceData = {
  gmv: 48500000,
  netRevenue: 7275000,
  platformFees: 1455000,
  refundsTotal: 135800,
  recentSettlements: [
    { id: 'SETT-2026-4401', vendorName: 'MeatCraft Farms Ltd.', amount: 485000, period: 'Aug 01 - Aug 07, 2026', status: 'Settled', processedAt: '2026-08-08 10:30' },
    { id: 'SETT-2026-4402', vendorName: 'Baramati Poultry Co-op', amount: 320000, period: 'Aug 01 - Aug 07, 2026', status: 'Processing', processedAt: '2026-08-09 14:15' }
  ]
};

const mockReportsData = {
  categoryDemand: [
    { category: 'Mutton / Lamb', orders: 1420, revenue: 1704000 },
    { category: 'Poultry', orders: 2890, revenue: 1156000 },
    { category: 'Fish & Seafood', orders: 980, revenue: 1168200 },
    { category: 'Ready to Cook', orders: 1250, revenue: 625000 },
    { category: 'Exotic Cuts', orders: 410, revenue: 738000 }
  ],
  cohortRetention: [
    { month: 'Month 1', retentionPct: 100 },
    { month: 'Month 2', retentionPct: 78 },
    { month: 'Month 3', retentionPct: 69 },
    { month: 'Month 4', retentionPct: 64 },
    { month: 'Month 5', retentionPct: 61 },
    { month: 'Month 6', retentionPct: 58 }
  ]
};

const mockUsersData = [
  { id: 'usr-1', name: 'Aarav Patel', tier: 'Platinum', spend: 42500, ordersCount: 18, location: 'Mumbai', email: 'aarav.p@gmail.com', walletBalance: 1250 },
  { id: 'usr-2', name: 'Priya Sharma', tier: 'Gold', spend: 28900, ordersCount: 12, location: 'Bengaluru', email: 'priya.s@yahoo.com', walletBalance: 800 },
  { id: 'usr-3', name: 'Rajesh Nair', tier: 'Silver', spend: 14200, ordersCount: 6, location: 'Navi Mumbai', email: 'rajesh.n@hotmail.com', walletBalance: 450 }
];

// ─── API ROUTES ───────────────────────────────────────────

// Users (Customer Accounts for CRM)
app.get('/api/v1/users', async () => ({ success: true, data: mockUsersData }));

// Products (Catalogue)
app.get('/api/v1/products', async () => ({ success: true, data: db.products }));
app.post('/api/v1/products', async (req) => {
  const newProduct = {
    id: `prod-${Date.now()}`,
    name: req.body?.name || 'New Meat Product',
    category: req.body?.category || 'Mutton / Lamb',
    price: parseFloat(req.body?.price) || 850,
    sku: req.body?.sku || `SKU-MUT-${Math.floor(Math.random()*900+100)}`,
    cutType: req.body?.cutType || 'Prime Cut',
    storageTemp: req.body?.storageTemp || '0°C to 4°C',
    inStock: req.body?.inStock !== false
  };
  db.products.unshift(newProduct);
  saveDb();
  return { success: true, data: newProduct };
});

// Support & Recalls Endpoints
app.get('/api/v1/support/tickets', async () => ({ success: true, data: db.tickets }));

app.post('/api/v1/support/tickets/:id/notes', async (req) => {
  const t = db.tickets.find(tk => tk.id === req.params.id);
  if (t) {
    const noteText = req.body?.note || 'Audit note added.';
    if (!t.notes) t.notes = [];
    t.notes.push(noteText);
    saveDb();
  }
  return { success: true, data: t };
});

app.post('/api/v1/support/tickets/:id/refund', async (req) => {
  const t = db.tickets.find(tk => tk.id === req.params.id);
  if (t) {
    t.status = 'Resolved';
    t.resolutionType = req.body?.type || 'Refund';
    saveDb();
  }
  return { success: true, data: t };
});

app.get('/api/v1/support/recalls', async () => ({ success: true, data: db.recalls }));

app.post('/api/v1/support/recalls/:id/quarantine', async (req) => {
  const r = db.recalls.find(rc => rc.id === req.params.id);
  if (r) {
    r.status = 'Quarantined';
    const lot = db.inventory.find(l => l.lotNumber === r.lotNumber);
    if (lot) lot.status = 'Quarantined';
    saveDb();
  }
  return { success: true, data: r };
});

app.post('/api/v1/support/recalls/:id/notify', async (req) => {
  const r = db.recalls.find(rc => rc.id === req.params.id);
  if (r) {
    r.notified = true;
    saveDb();
  }
  return { success: true, data: { id: req.params.id, notified: true }, message: `Quality taskforce dispatched for recall ${req.params.id}` };
});

// Coupons (Marketing)
app.get('/api/v1/coupons', async () => ({
  success: true,
  data: [
    { id: 'c-1', code: 'MEATFRESH10', discount: '10% OFF', active: true, usageCount: 1420 }
  ]
}));

// Banners (Content)
app.get('/api/v1/banners', async () => ({
  success: true,
  data: [
    { id: 'b-1', title: 'Weekend Lamb Special', bannerUrl: '/meet-commerce-dashboard-mockup-pack/01-banner-assets/banner-01-premium-lamb.png', active: true }
  ]
}));

// Tutorials (Content)
app.get('/api/v1/tutorials', async () => ({
  success: true,
  data: [
    { id: 't-1', title: 'QC Cold Chain Temperature Audit Guide', videoUrl: 'https://example.com/tutorial1.mp4' }
  ]
}));

// Wallet (Loyalty)
app.get('/api/v1/wallet', async () => ({
  success: true,
  data: { totalLoyaltyPoints: 148500, activeRewardsValue: 14850 }
}));

// Audit Logs (Governance)
app.get('/api/v1/admin/audit-logs', async () => ({
  success: true,
  data: [
    { id: 'log-1', action: 'KYC_APPROVED', target: 'Vendor VEN-101', actor: 'HQ Admin', timestamp: '2026-08-10 14:20' }
  ]
}));

// App Version (Platform)
app.get('/api/v1/app', async () => ({
  success: true,
  data: { minSupportedVersion: '1.4.0', currentLatestVersion: '2.1.0', mandatoryUpdate: false }
}));

// Categories (Merchandising)
app.get('/api/v1/categories', async () => ({
  success: true,
  data: [
    { id: 'cat-1', name: 'Mutton / Lamb', sortOrder: 1 },
    { id: 'cat-2', name: 'Poultry', sortOrder: 2 },
    { id: 'cat-3', name: 'Fish & Seafood', sortOrder: 3 }
  ]
}));

// Shops (Shops & FCs)
app.get('/api/v1/shops', async () => ({
  success: true,
  data: [
    { id: 'shop-1', name: 'South Mumbai FC', hubType: 'Fulfillment Center', city: 'Mumbai', activeStatus: 'Operational' },
    { id: 'shop-2', name: 'North Delhi Hub', hubType: 'Regional Hub', city: 'Delhi', activeStatus: 'Operational' }
  ]
}));

// Fee Settings (Configuration)
app.get('/api/v1/admin/fee-settings', async () => ({
  success: true,
  data: { baseDeliveryFee: 49, surgeMultiplier: 1.0, platformRakePct: 15.0, coldChainSurcharge: 25 }
}));

// Deliveries
app.get('/api/v1/deliveries', async (req) => ({ success: true, data: db.deliveries }));
app.get('/api/v1/deliveries/clusters', async () => ({ success: true, data: db.clusters }));
app.post('/api/v1/deliveries/verify-otp', async (req) => {
  const { otp, orderNumber } = req.body || {};
  if (otp === '9988' || otp === '1234') {
    return { success: true, message: `OTP Verified for order ${orderNumber}` };
  }
  return { success: false, message: 'Invalid delivery verification OTP' };
});

// Orders
app.get('/api/v1/orders', async () => ({ success: true, data: db.orders }));
app.get('/api/v1/orders/:id', async (req) => {
  const ord = db.orders.find(o => o.id === req.params.id || o.orderNumber === req.params.id);
  return { success: !!ord, data: ord || null };
});
app.patch('/api/v1/orders/:id/moderation', async (req) => {
  const { status } = req.body || {};
  const ord = db.orders.find(o => o.id === req.params.id);
  if (ord) {
    ord.videoModerationStatus = status;
    saveDb();
  }
  return { success: true, data: ord };
});

// Warehouse Receipts
app.get('/api/v1/warehouse-receipts', async () => ({ success: true, data: db.receipts }));
app.post('/api/v1/warehouse-receipts', async (req) => {
  const newRec = { id: `qc-${Date.now()}`, receiptNumber: `QCR-2026-${Math.floor(Math.random()*900+100)}`, receivedAt: new Date().toISOString(), ...req.body };
  db.receipts.unshift(newRec);
  saveDb();
  return { success: true, data: newRec };
});
app.patch('/api/v1/warehouse-receipts/:id/status', async (req) => {
  const rec = db.receipts.find(r => r.id === req.params.id || r.receiptNumber === req.params.id);
  if (rec) {
    rec.qcStatus = req.body?.qcStatus || rec.qcStatus;
    if (req.body?.notes) rec.notes = req.body.notes;
    saveDb();
  }
  return { success: true, data: rec };
});

// Inventory
app.get('/api/v1/inventory', async () => ({ success: true, data: db.inventory }));
app.post('/api/v1/inventory', async (req) => {
  const newLot = { id: `lot-${Date.now()}`, lotNumber: `LOT-MEAT-${Math.floor(Math.random()*9000+1000)}`, receivedDate: new Date().toISOString().split('T')[0], ...req.body };
  db.inventory.unshift(newLot);
  saveDb();
  return { success: true, data: newLot };
});

// Vendors
app.get('/api/v1/vendors', async () => ({ success: true, data: db.vendors }));
app.patch('/api/v1/vendors/:id/kyc', async (req) => {
  const v = db.vendors.find(v => v.id === req.params.id);
  if (v) {
    v.kycStatus = req.body?.kycStatus || 'Verified';
    v.riskScore = 'Low';
    saveDb();
  }
  return { success: true, data: v };
});

// Finance
app.get('/api/v1/shop-finance', async () => ({ success: true, data: mockFinanceData }));
app.get('/api/v1/shop-financials/summary', async () => ({ success: true, data: mockFinanceData }));

// Reports & Analytics
app.get('/api/v1/reports/summary', async () => ({ success: true, data: mockReportsData }));
app.get('/api/v1/reports/dashboard', async () => ({ success: true, data: mockReportsData }));

// Global Search
app.get('/api/v1/search', async (req) => {
  const q = (req.query?.q || '').toLowerCase();
  const matchedOrders = db.orders.filter(o => o.orderNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q));
  const matchedVendors = db.vendors.filter(v => v.companyName.toLowerCase().includes(q));
  const matchedLots = db.inventory.filter(l => l.lotNumber.toLowerCase().includes(q));
  const matchedReceipts = db.receipts.filter(r => r.receiptNumber.toLowerCase().includes(q));
  return { success: true, data: { orders: matchedOrders, vendors: matchedVendors, lots: matchedLots, receipts: matchedReceipts } };
});

// Start Server
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log('⚠️  ⚠️  ⚠️  MOCK API — NOT CONNECTED TO POSTGRES — DO NOT USE FOR REAL VERIFICATION  ⚠️  ⚠️  ⚠️');
console.log(`🎭 Mock API running at http://localhost:${PORT} (hardcoded/JSON-seeded data, no database)`);
