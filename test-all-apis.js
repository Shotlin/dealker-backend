import http from 'http';

const BASE = 'http://localhost:4500/api/v1';
let TOKEN = '';
const results = [];

function httpReq(method, path, body = null) {
  return new Promise((resolve) => {
    const url = new URL(`${BASE}${path}`);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    };
    if (TOKEN) opts.headers['Authorization'] = `Bearer ${TOKEN}`;

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data.slice(0, 200); }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', (e) => resolve({ status: 'ERR', data: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 'TIMEOUT', data: 'Request timed out' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function test(method, path, body = null, expect = 200) {
  const r = await httpReq(method, path, body);
  const ok = r.status === expect;
  const err = ok ? '' : (typeof r.data === 'object' ? (r.data?.message || r.data?.error || JSON.stringify(r.data).slice(0, 120)) : String(r.data).slice(0, 120));
  results.push({ s: ok ? '✅' : '❌', code: r.status, exp: expect, ep: `${method} ${path}`, err });
  return r;
}

async function main() {
  // 1. LOGIN
  const login = await httpReq('POST', '/admin/auth/login', { email: 'admin@bakaloo.com', password: 'Admin@123' });
  if (login.status !== 200 || !login.data?.data?.accessToken) {
    console.log('Login failed:', login.status, JSON.stringify(login.data));
    return;
  }
  TOKEN = login.data.data.accessToken;
  results.push({ s: '✅', code: 200, exp: 200, ep: 'POST /admin/auth/login', err: '' });

  // 2. DASHBOARD
  await test('GET', '/admin/dashboard/stats?period=week');
  await test('GET', '/admin/dashboard/revenue-chart?period=week');
  await test('GET', '/admin/dashboard/orders-by-hour');
  await test('GET', '/admin/dashboard/top-products');
  await test('GET', '/admin/dashboard/low-stock-alerts');
  await test('GET', '/admin/dashboard/pending-actions');
  await test('GET', '/admin/dashboard/live-stats');
  await test('GET', '/admin/dashboard/category-revenue');

  // 3. ADMIN ORDERS
  await test('GET', '/admin/orders');
  await test('GET', '/admin/orders/stats-by-status');

  // 4. ADMIN PRODUCTS
  await test('GET', '/admin/products');
  await test('GET', '/admin/products/analytics');
  await test('GET', '/admin/products/dead-stock');
  await test('GET', '/admin/products/low-margin');

  // 5. ADMIN CUSTOMERS
  await test('GET', '/admin/customers');
  await test('GET', '/admin/customers/ltv');          // correct path (not /stats)
  await test('GET', '/admin/customers/churned');
  await test('GET', '/admin/customers/vip');

  // 6. ADMIN RIDERS
  await test('GET', '/admin/riders');
  await test('GET', '/admin/riders/live-locations');

  // 7. ADMIN NOTIFICATIONS
  await test('GET', '/admin/notifications/campaigns'); // correct path (not /history)
  await test('GET', '/admin/notifications/templates');

  // 8. ADMIN ANALYTICS (correct endpoint names)
  await test('GET', '/admin/analytics/sales?startDate=2026-01-01&endDate=2026-12-31');
  await test('GET', '/admin/analytics/product-performance?startDate=2026-01-01&endDate=2026-12-31'); // correct (not /products)
  await test('GET', '/admin/analytics/customer-cohorts');  // correct (not /customers)
  await test('GET', '/admin/analytics/delivery');
  await test('GET', '/admin/analytics/financial?startDate=2026-01-01&endDate=2026-12-31');

  // 9. ADMIN BANNERS
  await test('GET', '/admin/banners');

  // 10. ADMIN ACTIVITY LOG
  await test('GET', '/admin/activity-log');

  // 11. ADMIN SETTINGS + USERS
  await test('GET', '/admin/users');
  await test('GET', '/admin/settings');

  // 12. PUBLIC
  const savedToken = TOKEN; TOKEN = '';
  await test('GET', '/categories');
  await test('GET', '/products');
  await test('GET', '/products/featured');
  await test('GET', '/products/new-arrivals');
  await test('GET', '/products/deals');
  await test('GET', '/banners');
  TOKEN = savedToken;

  // 13. USER-SCOPED
  await test('GET', '/users/me');
  await test('GET', '/cart');
  await test('GET', '/wishlist');
  await test('GET', '/addresses');
  await test('GET', '/notifications');
  await test('GET', '/wallet');            // correct path (not /wallet/balance)
  await test('GET', '/orders');
  await test('GET', '/coupons/available');

  // REPORT
  const passed = results.filter(r => r.s === '✅');
  const failed = results.filter(r => r.s === '❌');
  console.log(`\nTotal: ${results.length} | ✅ Passed: ${passed.length} | ❌ Failed: ${failed.length}\n`);
  if (failed.length > 0) {
    console.log('=== FAILED ENDPOINTS ===');
    for (const f of failed) console.log(`  ${f.s} [${f.code}] ${f.ep} → ${f.err}`);
  }
  console.log('\n=== ALL RESULTS ===');
  for (const r of results) console.log(`${r.s} [${r.code}] ${r.ep}${r.err ? ' → ' + r.err : ''}`);
}

main().catch(console.error);
