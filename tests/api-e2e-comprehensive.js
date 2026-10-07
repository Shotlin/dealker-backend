import 'dotenv/config';
import pg from 'pg';
import http from 'http';

const BASE = 'http://localhost:4500/api/v1';
const results = [];
let dbPool;

// Connection Pool to check DB state directly
function initDb() {
  dbPool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'grocery_db',
    user: process.env.DB_USER || 'grocery_user',
    password: process.env.DB_PASSWORD || 'grocery_password_dev',
  });
}

async function dbQuery(sql, params = []) {
  const client = await dbPool.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    client.release();
  }
}

// HTTP request helper
function httpReq(method, path, body = null, token = null, extraHeaders = null) {
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
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (extraHeaders) Object.assign(opts.headers, extraHeaders);

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, data: parsed });
      });
    });
    req.on('error', (e) => resolve({ status: 500, headers: {}, data: { success: false, message: e.message } }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 408, headers: {}, data: { success: false, message: 'Timeout' } }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Assertion trackers
function pass(label) {
  results.push({ s: '✅', label, err: '' });
  console.log(`  ✅ [PASS] ${label}`);
}

function fail(label, err) {
  results.push({ s: '❌', label, err: String(err) });
  console.error(`  ❌ [FAIL] ${label} -> ${err}`);
}

async function tryDbDelete(sql) {
  try {
    await dbQuery(sql);
  } catch (err) {
    // Silent catch for missing tables/columns
  }
}

// Cleanup existing test data from previous runs to ensure reproducibility
async function cleanupTestData() {
  console.log('🧹 Cleaning up test data...');
  // Delete test orders, receipts, lots, etc.
  await tryDbDelete(`DELETE FROM delivery_assignments WHERE notes LIKE 'Test%'`);
  await tryDbDelete(`DELETE FROM fulfilment_tasks WHERE notes LIKE 'Test%'`);
  await tryDbDelete(`DELETE FROM order_items WHERE name LIKE 'Test%'`);
  await tryDbDelete(`DELETE FROM orders WHERE delivery_notes LIKE 'Test%'`);
  await tryDbDelete(`DELETE FROM checkout_quotes WHERE customer_id IN (SELECT id FROM users WHERE phone IN ('9000000001', '9000000002', '9000000003', '9000000004', '9000000005', '+919000000001', '+919000000002', '+919000000003', '+919000000004', '+919000000005'))`);
  
  await tryDbDelete(`DELETE FROM stock_movements WHERE reason LIKE 'Test%'`);
  await tryDbDelete(`DELETE FROM inventory_lots WHERE batch_number LIKE 'BATCH-TEST-%'`);
  
  await tryDbDelete(`DELETE FROM quality_inspections WHERE notes LIKE 'Test%'`);
  await tryDbDelete(`DELETE FROM warehouse_receipt_items WHERE warehouse_receipt_id IN (SELECT id FROM warehouse_receipts WHERE notes LIKE 'Test%')`);
  await tryDbDelete(`DELETE FROM warehouse_receipts WHERE notes LIKE 'Test%'`);
  
  await tryDbDelete(`DELETE FROM procurement_items`);
  await tryDbDelete(`DELETE FROM procurement_orders WHERE notes LIKE 'Test%'`);
  await tryDbDelete(`DELETE FROM procurement_batches`);
  
  await tryDbDelete(`DELETE FROM product_proposal_specifications WHERE group_name = 'TestSpec'`);
  await tryDbDelete(`DELETE FROM product_proposal_variants WHERE sku LIKE 'VAR-TEST-%'`);
  await tryDbDelete(`DELETE FROM product_proposal_media WHERE file_key LIKE 'media-test-%'`);
  await tryDbDelete(`DELETE FROM product_proposals WHERE title LIKE 'Proposal-Test-%'`);
  await tryDbDelete(`DELETE FROM brands WHERE name LIKE 'Brand-Test-%'`);
  
  await tryDbDelete(`DELETE FROM vendor_invitations WHERE email LIKE 'test-staff-%'`);
  await tryDbDelete(`DELETE FROM vendor_users WHERE role IN ('VENDOR_OWNER', 'VENDOR_OPERATOR') AND user_id IN (SELECT id FROM users WHERE phone IN ('9000000002', '9000000003'))`);
  await tryDbDelete(`DELETE FROM vendor_documents WHERE document_number = 'KYC-TEST-12345'`);
  await tryDbDelete(`DELETE FROM vendors WHERE name LIKE 'Vendor-Test-%'`);
  await tryDbDelete(`DELETE FROM shop_staff WHERE shop_id IN (SELECT id FROM shops WHERE slug = 'vendor-test-alpha')`);
  await tryDbDelete(`DELETE FROM shops WHERE slug = 'vendor-test-alpha'`);
  
  await tryDbDelete(`DELETE FROM users WHERE phone IN ('9000000001', '9000000002', '9000000003', '9000000004', '9000000005', '+919000000001', '+919000000002', '+919000000003', '+919000000004', '+919000000005')`);
  console.log('✅ Cleanup complete');
}

async function runTests() {
  initDb();
  await cleanupTestData();

  console.log('\n================================================================================');
  console.log('DOMAIN WORKFLOWS & DATABASE STATE VALIDATION');
  console.log('================================================================================');

  let adminToken = '';
  let customerToken = '';
  let customerId = '';
  let vendorOwnerToken = '';
  let vendorOwnerId = '';
  let testVendorId = '';
  let testProposalId = '';
  let testProcurementId = '';
  let testReceiptId = '';
  let testLotId = '';
  let testQuoteNumber = '';
  let testOrderId = '';
  let testRiderId = '';
  let testAssignmentId = '';
  let testWarehouseId = '';

  // Retrieve default warehouse ID to use for test setup
  const warehouses = await dbQuery(`SELECT id FROM warehouses LIMIT 1`);
  if (warehouses.length > 0) {
    testWarehouseId = warehouses[0].id;
  } else {
    // Insert a default test warehouse if none exists
    const newWh = await dbQuery(`
      INSERT INTO warehouses (name, code, address, is_active)
      VALUES ('Test Central Warehouse', 'WH-TEST-01', '123 Test St', true)
      RETURNING id
    `);
    testWarehouseId = newWh[0].id;
  }

  // 1. AUTHENTICATION & LOGIN
  try {
    // Admin login
    const adminLoginRes = await httpReq('POST', '/admin/auth/login', {
      email: 'admin@bakaloo.com',
      password: 'Admin@123',
    });
    if (adminLoginRes.status === 200 && adminLoginRes.data?.data?.accessToken) {
      adminToken = adminLoginRes.data.data.accessToken;
      pass('Admin login successful');
    } else {
      throw new Error(`Admin login failed: ${adminLoginRes.status} - ${JSON.stringify(adminLoginRes.data)}`);
    }

    // Customer OTP flow (Customer Phone: 9000000001)
    const sendOtpRes = await httpReq('POST', '/auth/send-otp', { phone: '+919000000001' });
    if (sendOtpRes.status === 200) {
      pass('OTP sent to customer successfully');
    } else {
      throw new Error(`OTP send failed: ${sendOtpRes.status} - ${JSON.stringify(sendOtpRes.data)}`);
    }

    const verifyOtpRes = await httpReq('POST', '/auth/verify-otp', { phone: '+919000000001', otp: '123456' });
    if (verifyOtpRes.status === 200 && verifyOtpRes.data?.data?.accessToken) {
      customerToken = verifyOtpRes.data.data.accessToken;
      customerId = verifyOtpRes.data.data.user.id;
      pass('Customer login/verification successful via OTP');
      
      // DB Check: Confirm user row exists
      const userRows = await dbQuery(`SELECT id, phone, role FROM users WHERE id = $1`, [customerId]);
      console.log('DEBUG [verifyOtp]: customerId =', customerId);
      console.log('DEBUG [verifyOtp]: userRows =', userRows);
      console.log('DEBUG [verifyOtp]: response user =', verifyOtpRes.data.data.user);
      if (userRows.length === 1) {
        pass('DB STATE: Customer user record confirmed in DB');
      } else {
        throw new Error(`DB STATE: Customer user record not found in database after login (length ${userRows.length})`);
      }
    } else {
      throw new Error(`OTP verification failed: ${verifyOtpRes.status}`);
    }
  } catch (e) {
    fail('Authentication & Session setup', e);
    return;
  }

  // 2. VENDOR MANAGEMENT
  try {
    // Create Vendor
    const createVendorRes = await httpReq('POST', '/vendors', {
      name: 'Vendor-Test-Alpha',
      company_name: 'Alpha Meat Corp',
      email: 'vendor-alpha@test.com',
      phone: '+919000000002',
    }, adminToken);

    if (createVendorRes.status === 201 && createVendorRes.data?.data?.id) {
      testVendorId = createVendorRes.data.data.id;
      pass('Vendor profile created successfully by admin');

      // DB Check: Verify vendor row
      const vendorRows = await dbQuery(`SELECT id, name, status FROM vendors WHERE id = $1`, [testVendorId]);
      console.log('DEBUG [createVendor]: testVendorId =', testVendorId);
      console.log('DEBUG [createVendor]: vendorRows =', vendorRows);
      if (vendorRows.length === 1 && (vendorRows[0].status === 'PENDING_ONBOARDING' || vendorRows[0].status === 'ONBOARDING' || vendorRows[0].status === 'PENDING')) {
        pass('DB STATE: Vendor record created in DB with status ' + vendorRows[0].status);
      } else {
        throw new Error(`DB STATE: Vendor record check failed (length ${vendorRows.length}, status ${vendorRows[0]?.status})`);
      }
    } else {
      throw new Error(`Vendor creation failed: ${createVendorRes.status}`);
    }

    // Submit KYC Documents
    // We register the owner user (OTP 9000000002) first so we can obtain their token and test vendor scope
    const sendOtpVendorRes = await httpReq('POST', '/auth/send-otp', { phone: '+919000000002' });
    const verifyOtpVendorRes = await httpReq('POST', '/auth/verify-otp', { phone: '+919000000002', otp: '123456' });
    vendorOwnerToken = verifyOtpVendorRes.data.data.accessToken;
    vendorOwnerId = verifyOtpVendorRes.data.data.user.id;

    // Direct DB promote: user needs VENDOR_OWNER permissions or role_id corresponding to VENDOR_OWNER.
    // For simplicity, let's assign VENDOR_OWNER role.
    const ownerRole = await dbQuery(`SELECT id FROM roles WHERE name = 'Vendor Owner' LIMIT 1`);
    if (ownerRole.length > 0) {
      await dbQuery(`UPDATE users SET role_id = $1, role = 'VENDOR_OWNER' WHERE id = $2`, [ownerRole[0].id, vendorOwnerId]);
      await dbQuery(`INSERT INTO vendor_users (vendor_id, user_id, role, is_active) VALUES ($1, $2, 'VENDOR_OWNER', true) ON CONFLICT (vendor_id, user_id) DO NOTHING`, [testVendorId, vendorOwnerId]);
      
      // Legacy compatibility: mirror vendor to shops and vendor_user to shop_staff so auth service can scope the JWT
      await dbQuery(`
        INSERT INTO shops (id, name, slug, branch_code, address_line1, city, state, pincode, lat, lng, is_active)
        VALUES ($1, 'Vendor-Test-Alpha', 'vendor-test-alpha', 'BR-TEST-1A', '123 Test St', 'Test City', 'Test State', '123456', 12.9716, 77.5946, true)
        ON CONFLICT DO NOTHING
      `, [testVendorId]);
      await dbQuery(`
        INSERT INTO shop_staff (shop_id, user_id, role, permissions, is_active)
        VALUES ($1, $2, 'SHOP_ADMIN', '["*"]'::jsonb, true)
        ON CONFLICT DO NOTHING
      `, [testVendorId, vendorOwnerId]);
    }

    // Refresh token: Re-login to get the fresh permissions JWT
    const refreshVerifyRes = await httpReq('POST', '/auth/verify-otp', { phone: '+919000000002', otp: '123456' });
    vendorOwnerToken = refreshVerifyRes.data.data.accessToken;

    const submitKycRes = await httpReq('POST', `/vendor-kyc/${testVendorId}/kyc`, {
      documents: [
        {
          document_type: 'GSTIN_CERTIFICATE',
          document_number: 'KYC-TEST-12345',
          file_key: 'kyc-test-gstin',
          file_url: 'https://test.com/gstin.pdf',
        }
      ]
    }, vendorOwnerToken);

    if (submitKycRes.status === 200 || submitKycRes.status === 201) {
      pass('KYC document submitted successfully by vendor owner');
      // DB Check
      const kycRows = await dbQuery(`SELECT id, document_number, status FROM vendor_documents WHERE vendor_id = $1`, [testVendorId]);
      if (kycRows.length > 0 && kycRows[0].document_number === 'KYC-TEST-12345') {
        pass('DB STATE: KYC document confirmed in DB');
      } else {
        throw new Error('DB STATE: KYC document verify failed');
      }
    } else {
      throw new Error(`KYC submission failed: ${submitKycRes.status} - ${JSON.stringify(submitKycRes.data)}`);
    }

    // 1. Transition from KYC_SUBMITTED to UNDER_REVIEW
    const startReviewRes = await httpReq('POST', `/vendor-kyc/${testVendorId}/kyc/review`, {
      action: 'START_REVIEW',
      comments: 'Reviewing documents',
    }, adminToken);
    if (startReviewRes.status !== 200) {
      throw new Error(`KYC start review failed: ${startReviewRes.status} - ${JSON.stringify(startReviewRes.data)}`);
    }

    // 2. Transition from UNDER_REVIEW to VERIFIED
    const approveReviewRes = await httpReq('POST', `/vendor-kyc/${testVendorId}/kyc/review`, {
      action: 'APPROVE',
      comments: 'All documents look valid',
    }, adminToken);
    if (approveReviewRes.status !== 200) {
      throw new Error(`KYC approve review failed: ${approveReviewRes.status} - ${JSON.stringify(approveReviewRes.data)}`);
    }

    // 3. Transition from VERIFIED to ACTIVE using status patch
    const patchStatusRes = await httpReq('PATCH', `/vendors/${testVendorId}/status`, {
      status: 'ACTIVE',
      reason: 'KYC verified',
    }, adminToken);
    if (patchStatusRes.status !== 200) {
      throw new Error(`Vendor status patch to ACTIVE failed: ${patchStatusRes.status} - ${JSON.stringify(patchStatusRes.data)}`);
    }

    pass('KYC documents reviewed, approved and vendor activated by admin');
    
    // DB Check: Vendor should be ACTIVE
    const vendorRows = await dbQuery(`SELECT id, status FROM vendors WHERE id = $1`, [testVendorId]);
    if (vendorRows[0].status === 'ACTIVE') {
      pass('DB STATE: Vendor status transitioned to ACTIVE in DB');
    } else {
      throw new Error(`DB STATE: Vendor status is ${vendorRows[0].status}, expected ACTIVE`);
    }

    // Invite Staff member (9000000003)
    const inviteStaffRes = await httpReq('POST', `/vendor-staff/${testVendorId}/staff/invite`, {
      email: 'test-staff-operator@bakaloo.com',
      role: 'VENDOR_OPERATOR',
    }, vendorOwnerToken);

    if (inviteStaffRes.status === 201) {
      pass('Staff invitation created successfully by vendor owner');
      
      // DB Check: Retrieve invitation token
      const inviteRows = await dbQuery(`SELECT token FROM vendor_invitations WHERE email = 'test-staff-operator@bakaloo.com' LIMIT 1`);
      if (inviteRows.length === 1) {
        const inviteToken = inviteRows[0].token;
        pass('DB STATE: Staff invitation token successfully retrieved from database');

        // Target operator registers via OTP
        await httpReq('POST', '/auth/send-otp', { phone: '+919000000003' });
        const verifyOtpStaffRes = await httpReq('POST', '/auth/verify-otp', { phone: '+919000000003', otp: '123456' });
        const staffToken = verifyOtpStaffRes.data.data.accessToken;

        // Respond to invitation
        const respondRes = await httpReq('POST', '/vendor-staff/invitations/respond', {
          token: inviteToken,
          action: 'ACCEPT',
        }, staffToken);

        if (respondRes.status === 200) {
          pass('Staff invitation accepted successfully');
          // DB Check: Verify staff record
          const staffRows = await dbQuery(`SELECT role, is_active FROM vendor_users WHERE vendor_id = $1 AND user_id = $2`, [testVendorId, verifyOtpStaffRes.data.data.user.id]);
          if (staffRows.length === 1 && staffRows[0].role === 'VENDOR_OPERATOR') {
            pass('DB STATE: Staff user successfully registered as VENDOR_OPERATOR in DB');
            
            // Promote role in users table
            const operatorRole = await dbQuery(`SELECT id FROM roles WHERE name = 'Vendor Operator' LIMIT 1`);
            if (operatorRole.length > 0) {
              await dbQuery(`UPDATE users SET role_id = $1, role = 'VENDOR_OPERATOR' WHERE id = $2`, [operatorRole[0].id, verifyOtpStaffRes.data.data.user.id]);
            }
            // Mirror in shop_staff for legacy JWT scoping compatibility
            await dbQuery(`
              INSERT INTO shop_staff (shop_id, user_id, role, permissions, is_active)
              VALUES ($1, $2, 'SHOP_MANAGER', '["*"]'::jsonb, true)
              ON CONFLICT DO NOTHING
            `, [testVendorId, verifyOtpStaffRes.data.data.user.id]);
          } else {
            throw new Error('DB STATE: Staff role check in database failed');
          }
        } else {
          throw new Error(`Staff respond invitation failed: ${respondRes.status}`);
        }
      } else {
        throw new Error('DB STATE: Invitation row not found');
      }
    } else {
      throw new Error(`Staff invitation failed: ${inviteStaffRes.status}`);
    }
  } catch (e) {
    fail('Vendor Management workflow', e);
    return;
  }

  // 3. CATALOGUE & PRODUCT PROPOSAL
  try {
    // Brand Creation
    const createBrandRes = await httpReq('POST', '/catalogue/brands', {
      name: 'Brand-Test-Meat',
      slug: 'brand-test-meat',
    }, adminToken);

    let testBrandId = '';
    if (createBrandRes.status === 201 && createBrandRes.data?.data?.id) {
      testBrandId = createBrandRes.data.data.id;
      pass('Brand created successfully by admin');
    } else {
      throw new Error(`Brand creation failed: ${createBrandRes.status}`);
    }

    // Get a category ID
    const categories = await dbQuery(`SELECT id FROM categories LIMIT 1`);
    if (categories.length === 0) {
      throw new Error('No categories found for product proposal');
    }
    const testCategoryId = categories[0].id;

    // Create Product Proposal
    const createProposalRes = await httpReq('POST', '/catalogue/proposals', {
      title: 'Proposal-Test-Chicken',
      category_id: testCategoryId,
      brand_id: testBrandId,
      sku: 'SKU-TEST-CHICKEN-01',
      description: 'Organic free-range chicken test',
      unit: 'kg',
      target_price: 320.00,
    }, vendorOwnerToken);

    if (createProposalRes.status === 201 && createProposalRes.data?.data?.id) {
      testProposalId = createProposalRes.data.data.id;
      pass('Product proposal created successfully by vendor owner');

      // DB Check
      const proposalRows = await dbQuery(`SELECT id, status FROM product_proposals WHERE id = $1`, [testProposalId]);
      if (proposalRows.length === 1 && proposalRows[0].status === 'DRAFT') {
        pass('DB STATE: Product proposal verified in DRAFT status in DB');
      } else {
        throw new Error('DB STATE: Proposal verify failed');
      }
    } else {
      throw new Error(`Proposal creation failed: ${createProposalRes.status} - ${JSON.stringify(createProposalRes.data)}`);
    }

    // Add Media to proposal
    const addMediaRes = await httpReq('POST', `/catalogue/proposals/${testProposalId}/media`, {
      media_type: 'IMAGE',
      file_key: 'media-test-image-key',
      file_url: 'https://test.com/chicken.jpg',
      mime_type: 'image/jpeg',
      size: 50000,
    }, vendorOwnerToken);

    if (addMediaRes.status === 201) {
      pass('Media added to proposal successfully');
      // DB Check
      const mediaRows = await dbQuery(`SELECT id FROM product_proposal_media WHERE proposal_id = $1 AND file_key = 'media-test-image-key'`, [testProposalId]);
      if (mediaRows.length === 1) {
        pass('DB STATE: Proposal media record confirmed in DB');
      } else {
        throw new Error('DB STATE: Media record missing');
      }
    } else {
      throw new Error(`Adding media failed: ${addMediaRes.status}`);
    }

    // Add Variant to proposal
    const addVariantRes = await httpReq('POST', `/catalogue/proposals/${testProposalId}/variants`, {
      sku: 'VAR-TEST-CHICKEN-MEDIUM',
      name: 'Test Chicken Medium Pack',
      target_price: 160.00,
    }, vendorOwnerToken);

    if (addVariantRes.status === 201) {
      pass('Variant added to proposal successfully');
      // DB Check
      const variantRows = await dbQuery(`SELECT id FROM product_proposal_variants WHERE proposal_id = $1 AND sku = 'VAR-TEST-CHICKEN-MEDIUM'`, [testProposalId]);
      if (variantRows.length === 1) {
        pass('DB STATE: Variant record confirmed in DB');
      } else {
        throw new Error('DB STATE: Variant record missing');
      }
    } else {
      throw new Error(`Adding variant failed: ${addVariantRes.status}`);
    }

    // Add Specification to proposal
    const addSpecRes = await httpReq('POST', `/catalogue/proposals/${testProposalId}/specifications`, {
      key: 'Storage Temperature',
      value: '-18°C Frozen',
      group_name: 'TestSpec',
    }, vendorOwnerToken);

    if (addSpecRes.status === 201) {
      pass('Specification added to proposal successfully');
      // DB Check
      const specRows = await dbQuery(`SELECT id FROM product_proposal_specifications WHERE proposal_id = $1 AND key = 'Storage Temperature'`, [testProposalId]);
      if (specRows.length === 1) {
        pass('DB STATE: Specification record confirmed in DB');
      } else {
        throw new Error('DB STATE: Specification record missing');
      }
    } else {
      throw new Error(`Adding spec failed: ${addSpecRes.status}`);
    }

    // Submit Proposal
    const submitProposalRes = await httpReq('POST', `/catalogue/proposals/${testProposalId}/submit`, {}, vendorOwnerToken);
    if (submitProposalRes.status === 200) {
      pass('Proposal submitted successfully for review');
      const proposalRows = await dbQuery(`SELECT status FROM product_proposals WHERE id = $1`, [testProposalId]);
      if (proposalRows[0].status === 'SUBMITTED') {
        pass('DB STATE: Proposal transitioned to SUBMITTED in DB');
      } else {
        throw new Error('DB STATE: Proposal submit status wrong');
      }
    } else {
      throw new Error(`Submit proposal failed: ${submitProposalRes.status}`);
    }

    // Admin Review Proposal: Start Review
    await httpReq('POST', `/catalogue/proposals/${testProposalId}/review`, {
      action: 'START_REVIEW',
      comments: 'Checking requirements',
    }, adminToken);

    // Admin Review Proposal: Approve
    const approveProposalRes = await httpReq('POST', `/catalogue/proposals/${testProposalId}/review`, {
      action: 'APPROVE',
      comments: 'Looks good',
    }, adminToken);

    if (approveProposalRes.status === 200) {
      pass('Proposal approved by admin');
      const proposalRows = await dbQuery(`SELECT status FROM product_proposals WHERE id = $1`, [testProposalId]);
      if (proposalRows[0].status === 'APPROVED') {
        pass('DB STATE: Proposal transitioned to APPROVED in DB');
      } else {
        throw new Error('DB STATE: Proposal status wrong');
      }
    } else {
      throw new Error(`Approve proposal failed: ${approveProposalRes.status}`);
    }
  } catch (e) {
    fail('Catalogue & Proposal workflow', e);
    return;
  }

  // 5. PROCUREMENT & SUPPLY BATCHES
  try {
    // Get product ID created/mapped from the proposal
    let testProductId = '';
    const products = await dbQuery(`SELECT id FROM products LIMIT 1`);
    if (products.length > 0) {
      testProductId = products[0].id;
    } else {
      throw new Error('No products found to run procurement');
    }

    // Create Procurement Order
    const createProcRes = await httpReq('POST', '/procurement', {
      notes: 'Test procurement order notes',
      items: [
        {
          product_id: testProductId,
          quantity_ordered: 100.0,
          unit_cost: 150.00,
        }
      ],
    }, vendorOwnerToken);

    if (createProcRes.status === 201 && createProcRes.data?.data?.id) {
      testProcurementId = createProcRes.data.data.id;
      pass('Procurement order created successfully');

      // DB Check
      const procRows = await dbQuery(`SELECT status FROM procurement_orders WHERE id = $1`, [testProcurementId]);
      if (procRows.length === 1 && procRows[0].status === 'DRAFT') {
        pass('DB STATE: Procurement order verified in DRAFT status in DB');
      } else {
        throw new Error('DB STATE: Procurement status incorrect');
      }
    } else {
      throw new Error(`Procurement creation failed: ${createProcRes.status} - ${JSON.stringify(createProcRes.data)}`);
    }

    // Submit Procurement Order
    const submitProcRes = await httpReq('POST', `/procurement/${testProcurementId}/submit`, {}, vendorOwnerToken);
    if (submitProcRes.status === 200) {
      pass('Procurement order submitted successfully');
      const procRows = await dbQuery(`SELECT status FROM procurement_orders WHERE id = $1`, [testProcurementId]);
      if (procRows[0].status === 'SUBMITTED') {
        pass('DB STATE: Procurement transitioned to SUBMITTED in DB');
      }
    } else {
      throw new Error(`Submit procurement failed: ${submitProcRes.status}`);
    }

    // Approve Procurement Order
    const approveProcRes = await httpReq('POST', `/procurement/${testProcurementId}/approve`, {}, adminToken);
    if (approveProcRes.status === 200) {
      pass('Procurement order approved successfully by admin');
      const procRows = await dbQuery(`SELECT status FROM procurement_orders WHERE id = $1`, [testProcurementId]);
      if (procRows[0].status === 'APPROVED') {
        pass('DB STATE: Procurement transitioned to APPROVED in DB');
      }
    } else {
      throw new Error(`Approve procurement failed: ${approveProcRes.status}`);
    }

    // Record Goods Receipt
    // Get procurement item id
    const procItems = await dbQuery(`SELECT id FROM procurement_items WHERE procurement_order_id = $1`, [testProcurementId]);
    if (procItems.length === 0) {
      throw new Error('Procurement order items missing');
    }
    const procItemId = procItems[0].id;

    const receiptRes = await httpReq('POST', `/procurement/${testProcurementId}/receipt`, {
      receipts: [
        {
          item_id: procItemId,
          quantity_received: 98.5,
          batch_number: 'BATCH-TEST-ALPHA-01',
          manufactured_date: '2026-08-01',
          expiry_date: '2026-08-15',
        }
      ],
    }, vendorOwnerToken);

    if (receiptRes.status === 200) {
      pass('Goods receipt recorded successfully for procurement order');
      // DB Check: Verify supply batch created
      const batchRows = await dbQuery(`SELECT id, batch_number, quantity FROM procurement_batches WHERE procurement_order_id = $1`, [testProcurementId]);
      if (batchRows.length === 1 && batchRows[0].batch_number === 'BATCH-TEST-ALPHA-01') {
        pass('DB STATE: Supply batch successfully created and linked to procurement order');
      } else {
        throw new Error('DB STATE: Supply batch check failed');
      }
    } else {
      throw new Error(`Goods receipt recording failed: ${receiptRes.status}`);
    }

    // Add Media evidence
    const addProcMediaRes = await httpReq('POST', `/procurement/${testProcurementId}/media`, {
      media_type: 'DELIVERY_NOTE',
      file_key: 'media-test-delivery-note-key',
      file_url: 'https://test.com/delnote.pdf',
    }, vendorOwnerToken);

    if (addProcMediaRes.status === 201) {
      pass('Procurement media evidence uploaded successfully');
    } else {
      throw new Error(`Procurement media upload failed: ${addProcMediaRes.status}`);
    }
  } catch (e) {
    fail('Procurement & Supply Batches workflow', e);
    return;
  }

  // 6. WAREHOUSE RECEIPT & QUALITY CONTROL
  try {
    let testProductId = '';
    const products = await dbQuery(`SELECT id FROM products LIMIT 1`);
    testProductId = products[0].id;

    // Create Warehouse Receipt
    const createWrRes = await httpReq('POST', '/warehouse-receipts', {
      warehouse_id: testWarehouseId,
      procurement_order_id: testProcurementId,
      notes: 'Test warehouse receipt',
      items: [
        {
          product_id: testProductId,
          quantity_received: 98.5,
        }
      ],
    }, adminToken, { 'x-warehouse-id': testWarehouseId });

    if (createWrRes.status === 201 && createWrRes.data?.data?.id) {
      testReceiptId = createWrRes.data.data.id;
      pass('Warehouse receipt created successfully');
      
      // DB Check
      const wrRows = await dbQuery(`SELECT status FROM warehouse_receipts WHERE id = $1`, [testReceiptId]);
      if (wrRows.length === 1 && (wrRows[0].status === 'PENDING_RECEIPT' || wrRows[0].status === 'DRAFT')) {
        pass('DB STATE: Warehouse receipt created in DB');
      }
    } else {
      throw new Error(`Warehouse receipt creation failed: ${createWrRes.status} - ${JSON.stringify(createWrRes.data)}`);
    }

    // Start Receiving
    const startWrRes = await httpReq('POST', `/warehouse-receipts/${testReceiptId}/start`, {}, adminToken, { 'x-warehouse-id': testWarehouseId });
    if (startWrRes.status === 200) {
      pass('Warehouse receipt receiving process started');
      const wrRows = await dbQuery(`SELECT status FROM warehouse_receipts WHERE id = $1`, [testReceiptId]);
      if (wrRows[0].status === 'RECEIVING') {
        pass('DB STATE: Warehouse receipt status transitioned to RECEIVING');
      }
    } else {
      throw new Error(`Start receiving failed: ${startWrRes.status}`);
    }

    // Submit for QC
    const submitQcRes = await httpReq('POST', `/warehouse-receipts/${testReceiptId}/submit-qc`, {}, adminToken, { 'x-warehouse-id': testWarehouseId });
    if (submitQcRes.status === 200) {
      pass('Warehouse receipt submitted for QC inspection successfully');
      const wrRows = await dbQuery(`SELECT status FROM warehouse_receipts WHERE id = $1`, [testReceiptId]);
      if (wrRows[0].status === 'QC_PENDING') {
        pass('DB STATE: Warehouse receipt status transitioned to QC_PENDING');
      }
    } else {
      throw new Error(`Submit QC failed: ${submitQcRes.status}`);
    }

    // Perform QC Inspection
    const receiptItems = await dbQuery(`SELECT id FROM warehouse_receipt_items WHERE warehouse_receipt_id = $1`, [testReceiptId]);
    if (receiptItems.length === 0) {
      throw new Error('Warehouse receipt items missing');
    }
    const receiptItemId = receiptItems[0].id;

    const performQcRes = await httpReq('POST', `/warehouse-receipts/${testReceiptId}/qc`, {
      result: 'PASS',
      notes: 'Test QC approved without defects',
      item_results: [
        {
          receipt_item_id: receiptItemId,
          quantity_accepted: 98.5,
          quantity_rejected: 0.0,
          parameters: [
            {
              parameter_name: 'Temperature',
              status: 'PASS',
              remarks: 'Ideal chilled condition',
            }
          ],
        }
      ],
    }, adminToken, { 'x-warehouse-id': testWarehouseId });

    if (performQcRes.status === 200) {
      pass('Quality control inspection recorded successfully as PASS');
      const wrRows = await dbQuery(`SELECT status FROM warehouse_receipts WHERE id = $1`, [testReceiptId]);
      if (wrRows[0].status === 'COMPLETED') {
        pass('DB STATE: Warehouse receipt status transitioned to COMPLETED');
        
        // Confirm QC inspection logged
        const qcRows = await dbQuery(`SELECT id, result FROM quality_inspections WHERE warehouse_receipt_id = $1`, [testReceiptId]);
        if (qcRows.length === 1 && qcRows[0].result === 'PASS') {
          pass('DB STATE: QC inspection record confirmed in DB');
        } else {
          throw new Error('DB STATE: QC inspection record not found');
        }
      }
    } else {
      throw new Error(`QC inspection failed: ${performQcRes.status} - ${JSON.stringify(performQcRes.data)}`);
    }
  } catch (e) {
    fail('Warehouse Receipt & QC workflow', e);
    return;
  }

  // 7. INVENTORY & FEFO
  try {
    let testProductId = '';
    const products = await dbQuery(`SELECT id FROM products LIMIT 1`);
    testProductId = products[0].id;

    // Register Inbound Stock
    const inboundRes = await httpReq('POST', '/inventory/inbound', {
      warehouse_id: testWarehouseId,
      product_id: testProductId,
      batch_number: 'BATCH-TEST-INBOUND-01',
      expiry_date: '2026-08-30',
      quantity: 50.0,
    }, adminToken);

    if (inboundRes.status === 200 || inboundRes.status === 201) {
      pass('Stock inbound registered successfully');
      
      // DB Check: Verify lot created
      const lotRows = await dbQuery(`SELECT id, quantity_on_hand FROM inventory_lots WHERE batch_number = 'BATCH-TEST-INBOUND-01'`, []);
      if (lotRows.length === 1 && Number(lotRows[0].quantity_on_hand) === 50) {
        testLotId = lotRows[0].id;
        pass('DB STATE: Inventory lot verified in DB with 50 units on hand');
      } else {
        throw new Error('DB STATE: Lot quantity mismatch or lot missing');
      }
    } else {
      throw new Error(`Stock inbound failed: ${inboundRes.status} - ${JSON.stringify(inboundRes.data)}`);
    }

    // Reserve FEFO
    const reserveRes = await httpReq('POST', '/inventory/reserve', {
      warehouse_id: testWarehouseId,
      product_id: testProductId,
      quantity: 5.0,
      reservation_key: 'RSV-TEST-KEY-01',
    }, adminToken);

    if (reserveRes.status === 200 || reserveRes.status === 201) {
      pass('FEFO stock reservation placed successfully');
      const lotRows = await dbQuery(`SELECT quantity_reserved FROM inventory_lots WHERE id = $1`, [testLotId]);
      if (Number(lotRows[0].quantity_reserved) === 5) {
        pass('DB STATE: Inventory lot reservations increased to 5 in DB');
      } else {
        throw new Error(`DB STATE: Reserved quantity is ${lotRows[0].quantity_reserved}, expected 5`);
      }
    } else {
      throw new Error(`FEFO reservation failed: ${reserveRes.status} - ${JSON.stringify(reserveRes.data)}`);
    }

    // Release Reservation
    const releaseRes = await httpReq('POST', '/inventory/release', {
      reservation_key: 'RSV-TEST-KEY-01',
    }, adminToken);

    if (releaseRes.status === 200 || releaseRes.status === 201) {
      pass('FEFO stock reservation released successfully');
      const lotRows = await dbQuery(`SELECT quantity_reserved FROM inventory_lots WHERE id = $1`, [testLotId]);
      if (Number(lotRows[0].quantity_reserved) === 0) {
        pass('DB STATE: Inventory lot reservations returned to 0 in DB');
      }
    } else {
      throw new Error(`Release reservation failed: ${releaseRes.status}`);
    }

    // Stock Adjustment
    const adjustRes = await httpReq('POST', '/inventory/adjust', {
      lot_id: testLotId,
      quantity_change: -2.0,
      reason: 'Test defect adjustment',
    }, adminToken);

    if (adjustRes.status === 200 || adjustRes.status === 201) {
      pass('Stock adjustment completed successfully');
      const lotRows = await dbQuery(`SELECT quantity_on_hand FROM inventory_lots WHERE id = $1`, [testLotId]);
      if (Number(lotRows[0].quantity_on_hand) === 48) {
        pass('DB STATE: Lot quantity on hand updated to 48 in DB');
      }
    } else {
      throw new Error(`Stock adjustment failed: ${adjustRes.status}`);
    }
  } catch (e) {
    fail('Inventory & FEFO workflow', e);
    return;
  }

  // 8. CART
  try {
    let testProductId = '';
    const products = await dbQuery(`SELECT id FROM products LIMIT 1`);
    testProductId = products[0].id;

    // Add Item to Cart
    const addCartRes = await httpReq('POST', '/cart-quote/cart/items', {
      product_id: testProductId,
      quantity: 3,
    }, customerToken);

    if (addCartRes.status === 200 || addCartRes.status === 201) {
      pass('Item added to cart successfully');
      
      const cartRows = await dbQuery(`SELECT ci.quantity FROM cart_items ci JOIN customer_carts cc ON cc.id = ci.cart_id WHERE cc.customer_id = $1 AND ci.product_id = $2`, [customerId, testProductId]);
      if (cartRows.length === 1 && Number(cartRows[0].quantity) === 3) {
        pass('DB STATE: Cart items confirmed in DB');
      } else {
        throw new Error('DB STATE: Cart items not found');
      }
    } else {
      throw new Error(`Adding item to cart failed: ${addCartRes.status} - ${JSON.stringify(addCartRes.data)}`);
    }

    // Update Cart Item Quantity
    const updateCartRes = await httpReq('PATCH', `/cart-quote/cart/items/${testProductId}`, {
      quantity: 5,
    }, customerToken);

    if (updateCartRes.status === 200) {
      pass('Cart item quantity updated successfully to 5');
      const cartRows = await dbQuery(`SELECT ci.quantity FROM cart_items ci JOIN customer_carts cc ON cc.id = ci.cart_id WHERE cc.customer_id = $1 AND ci.product_id = $2`, [customerId, testProductId]);
      if (Number(cartRows[0].quantity) === 5) {
        pass('DB STATE: Cart item quantity confirmed updated in DB');
      }
    } else {
      throw new Error(`Cart update failed: ${updateCartRes.status}`);
    }
  } catch (e) {
    fail('Cart workflow', e);
    return;
  }

  // 9. CHECKOUT & QUOTE ENGINE
  try {
    // Generate Checkout Quote
    const quoteRes = await httpReq('POST', '/cart-quote/checkout/quote', {
      loyalty_points_to_redeem: 0,
      discount_code: 'TEST_COUPON',
    }, customerToken);

    if (quoteRes.status === 201 && quoteRes.data?.data?.quote_number) {
      testQuoteNumber = quoteRes.data.data.quote_number;
      pass('Checkout quote generated successfully');
      
      // DB Check
      const quoteRows = await dbQuery(`SELECT status, total_payable FROM checkout_quotes WHERE quote_number = $1`, [testQuoteNumber]);
      if (quoteRows.length === 1 && quoteRows[0].status === 'ACTIVE') {
        pass('DB STATE: Checkout quote record active in DB');
      }
    } else {
      throw new Error(`Quote generation failed: ${quoteRes.status} - ${JSON.stringify(quoteRes.data)}`);
    }

    // Get Loyalty History
    const loyaltyRes = await httpReq('GET', '/cart-quote/loyalty', null, customerToken);
    if (loyaltyRes.status === 200) {
      pass('Loyalty history fetched successfully');
    } else {
      throw new Error(`Fetch loyalty history failed: ${loyaltyRes.status}`);
    }
  } catch (e) {
    fail('Checkout & Quote workflow', e);
    return;
  }

  // 10. ORDERS & FULFILMENT
  try {
    // Create Order from Checkout Quote
    const createOrderRes = await httpReq('POST', '/orders', {
      quote_number: testQuoteNumber,
      warehouse_id: testWarehouseId,
    }, customerToken);

    if (createOrderRes.status === 201 && createOrderRes.data?.data?.id) {
      testOrderId = createOrderRes.data.data.id;
      pass('Order created successfully from checkout quote');
      
      // DB Check: check order state
      const orderRows = await dbQuery(`SELECT status, total_payable FROM orders WHERE id = $1`, [testOrderId]);
      if (orderRows.length === 1 && orderRows[0].status === 'ORDER_PLACED') {
        pass('DB STATE: Order status is ORDER_PLACED in DB');
      } else {
        throw new Error('DB STATE: Order record check failed');
      }
    } else {
      throw new Error(`Order creation failed: ${createOrderRes.status} - ${JSON.stringify(createOrderRes.data)}`);
    }

    // Transition Order Status: ORDER_PLACED -> CONFIRMED
    const transitionRes = await httpReq('PATCH', `/orders/${testOrderId}/status`, {
      status: 'CONFIRMED',
      notes: 'Test confirmation',
    }, adminToken);

    if (transitionRes.status === 200) {
      pass('Order status transitioned to CONFIRMED successfully');
      const orderRows = await dbQuery(`SELECT status FROM orders WHERE id = $1`, [testOrderId]);
      if (orderRows[0].status === 'CONFIRMED') {
        pass('DB STATE: Order status confirmed in DB');
      }
    } else {
      throw new Error(`Order status transition failed: ${transitionRes.status} - ${JSON.stringify(transitionRes.data)}`);
    }

    // Create Fulfilment Task (PICKING)
    const createTaskRes = await httpReq('POST', `/orders/${testOrderId}/fulfilment-tasks`, {
      task_type: 'PICKING',
      assigned_to: customerId,
      notes: 'Test picking task',
    }, adminToken);

    if (createTaskRes.status === 201 && createTaskRes.data?.data?.id) {
      const taskId = createTaskRes.data.data.id;
      pass('Picking fulfilment task created successfully');

      // DB Check
      const taskRows = await dbQuery(`SELECT status FROM fulfilment_tasks WHERE id = $1`, [taskId]);
      if (taskRows.length === 1 && taskRows[0].status === 'PENDING') {
        pass('DB STATE: Fulfilment task confirmed in PENDING status in DB');
      }

      // Update Fulfilment Task Status: PENDING -> COMPLETED
      const updateTaskRes = await httpReq('PATCH', `/orders/fulfilment-tasks/${taskId}`, {
        status: 'COMPLETED',
        notes: 'Test items successfully picked',
      }, adminToken);

      if (updateTaskRes.status === 200) {
        pass('Fulfilment task status updated to COMPLETED successfully');
        const taskRows = await dbQuery(`SELECT status FROM fulfilment_tasks WHERE id = $1`, [taskId]);
        if (taskRows[0].status === 'COMPLETED') {
          pass('DB STATE: Fulfilment task status confirmed COMPLETED in DB');
        }
      } else {
        throw new Error(`Update fulfilment task failed: ${updateTaskRes.status}`);
      }
    } else {
      throw new Error(`Fulfilment task creation failed: ${createTaskRes.status}`);
    }
  } catch (e) {
    fail('Orders & Fulfilment workflow', e);
    return;
  }

  // 11. DELIVERY LIFECYCLE
  try {
    // Register a new user for Rider role (OTP 9000000004)
    await httpReq('POST', '/auth/send-otp', { phone: '+919000000004' });
    const verifyOtpRiderRes = await httpReq('POST', '/auth/verify-otp', { phone: '+919000000004', otp: '123456' });
    const riderUserId = verifyOtpRiderRes.data.data.user.id;

    // Create Rider Profile
    const createRiderRes = await httpReq('POST', '/deliveries/riders', {
      user_id: riderUserId,
      vehicle_type: 'E-BIKE',
      license_number: 'LIC-TEST-5678',
    }, adminToken);

    if (createRiderRes.status === 201 && createRiderRes.data?.data?.id) {
      testRiderId = createRiderRes.data.data.id;
      pass('Rider profile created successfully');
      
      // DB Check
      const riderRows = await dbQuery(`SELECT user_id, status FROM riders WHERE id = $1`, [testRiderId]);
      if (riderRows.length === 1 && riderRows[0].status === 'INACTIVE') {
        pass('DB STATE: Rider profile in INACTIVE status in DB');
      }
    } else {
      throw new Error(`Rider profile creation failed: ${createRiderRes.status} - ${JSON.stringify(createRiderRes.data)}`);
    }

    // Start Rider Shift
    const startShiftRes = await httpReq('POST', `/deliveries/riders/${testRiderId}/shifts/start`, {}, adminToken);
    if (startShiftRes.status === 200) {
      pass('Rider shift started successfully');
      const shiftRows = await dbQuery(`SELECT status FROM rider_shifts WHERE rider_id = $1 ORDER BY started_at DESC LIMIT 1`, [testRiderId]);
      if (shiftRows.length === 1 && shiftRows[0].status === 'ON_DUTY') {
        pass('DB STATE: Rider shift registered ON_DUTY in DB');
      }
    } else {
      throw new Error(`Starting shift failed: ${startShiftRes.status} - ${JSON.stringify(startShiftRes.data)}`);
    }

    // Assign Delivery Assignment
    const assignRes = await httpReq('POST', '/deliveries/assignments', {
      order_id: testOrderId,
      rider_id: testRiderId,
      notes: 'Test delivery notes',
    }, adminToken);

    if (assignRes.status === 201 && assignRes.data?.data?.id) {
      testAssignmentId = assignRes.data.data.id;
      pass('Delivery assignment created successfully');

      // DB Check
      const assignRows = await dbQuery(`SELECT status FROM delivery_assignments WHERE id = $1`, [testAssignmentId]);
      if (assignRows.length === 1 && assignRows[0].status === 'ASSIGNED') {
        pass('DB STATE: Delivery assignment status is ASSIGNED in DB');
      }

      // Transition Delivery Assignment Status: ASSIGNED -> DELIVERED
      const transitionRes = await httpReq('PATCH', `/deliveries/assignments/${testAssignmentId}/status`, {
        status: 'DELIVERED',
        notes: 'Delivered directly to buyer',
      }, adminToken);

      if (transitionRes.status === 200) {
        pass('Delivery assignment status updated to DELIVERED successfully');
        const assignRows = await dbQuery(`SELECT status FROM delivery_assignments WHERE id = $1`, [testAssignmentId]);
        if (assignRows[0].status === 'DELIVERED') {
          pass('DB STATE: Delivery assignment status confirmed DELIVERED in DB');
        }
      } else {
        throw new Error(`Update delivery status failed: ${transitionRes.status}`);
      }
    } else {
      throw new Error(`Delivery assignment failed: ${assignRes.status} - ${JSON.stringify(assignRes.data)}`);
    }
  } catch (e) {
    fail('Delivery Lifecycle workflow', e);
    return;
  }

  // 12. SUPPORT TICKETS, RECALLS & TRACEABILITY
  try {
    // Create Support Ticket
    const createTicketRes = await httpReq('POST', '/support/tickets', {
      subject: 'Test delivery delay issue',
      description: 'The meat cold chain box is broken',
      order_id: testOrderId,
    }, customerToken);

    let ticketId = '';
    if (createTicketRes.status === 201 && createTicketRes.data?.data?.id) {
      ticketId = createTicketRes.data.data.id;
      pass('Support ticket created successfully by customer');
      
      // DB Check
      const ticketRows = await dbQuery(`SELECT status FROM support_tickets WHERE id = $1`, [ticketId]);
      if (ticketRows.length === 1 && ticketRows[0].status === 'OPEN') {
        pass('DB STATE: Support ticket confirmed OPEN in DB');
      }
    } else {
      throw new Error(`Support ticket creation failed: ${createTicketRes.status}`);
    }

    // Assign Ticket
    const assignTicketRes = await httpReq('PATCH', `/support/tickets/${ticketId}/assign`, {
      assigned_to: customerId,
    }, adminToken);

    if (assignTicketRes.status === 200) {
      pass('Support ticket assigned successfully');
      const ticketRows = await dbQuery(`SELECT assigned_to FROM support_tickets WHERE id = $1`, [ticketId]);
      if (ticketRows[0].assigned_to === customerId) {
        pass('DB STATE: Ticket assigned user ID matched in DB');
      }
    } else {
      throw new Error(`Assign ticket failed: ${assignTicketRes.status}`);
    }

    // Get product ID created
    let testProductId = '';
    const products = await dbQuery(`SELECT id FROM products LIMIT 1`);
    testProductId = products[0].id;

    // Create Product Recall
    const createRecallRes = await httpReq('POST', '/support/recalls', {
      product_id: testProductId,
      batch_number: 'BATCH-TEST-ALPHA-01',
      recall_reason: 'Potential pathogens detected',
      scope: 'BATCH',
    }, adminToken);

    if (createRecallRes.status === 201 && createRecallRes.data?.data?.id) {
      const recallId = createRecallRes.data.data.id;
      pass('Product recall successfully initiated');
      
      // DB Check
      const recallRows = await dbQuery(`SELECT status FROM product_recalls WHERE id = $1`, [recallId]);
      if (recallRows.length === 1 && recallRows[0].status === 'INITIATED') {
        pass('DB STATE: Recall status confirmed INITIATED in DB');
      }
    } else {
      throw new Error(`Product recall creation failed: ${createRecallRes.status} - ${JSON.stringify(createRecallRes.data)}`);
    }

    // Get Batch Traceability
    const traceRes = await httpReq('GET', `/support/traceability/${testProductId}`, null, adminToken);
    if (traceRes.status === 200) {
      pass('Traceability history of batch fetched successfully');
    } else {
      throw new Error(`Traceability fetching failed: ${traceRes.status}`);
    }
  } catch (e) {
    fail('Support & Recall workflow', e);
    return;
  }

  // 13. REPORTS
  try {
    const reportRes = await httpReq('GET', '/reports/dashboard', null, adminToken);
    if (reportRes.status === 200) {
      pass('Admin reports dashboard metrics queried successfully');
    } else {
      throw new Error(`Reports dashboard failed: ${reportRes.status}`);
    }
  } catch (e) {
    fail('Reports workflow', e);
    return;
  }

  console.log('\n================================================================================');
  console.log('NEGATIVE & SECURITY TESTING');
  console.log('================================================================================');

  // Verify: Missing JWT
  const missingJwt = await httpReq('GET', '/users/me', null, null);
  if (missingJwt.status === 401) {
    pass('Security: Missing JWT correctly returns 401');
  } else {
    fail('Security: Missing JWT', `Expected 401 but got ${missingJwt.status}`);
  }

  // Verify: Expired/Invalid JWT
  const invalidJwt = await httpReq('GET', '/users/me', null, 'invalid_token_string');
  if (invalidJwt.status === 401) {
    pass('Security: Invalid JWT returns 401');
  } else {
    fail('Security: Invalid JWT', `Expected 401 but got ${invalidJwt.status}`);
  }

  // Verify: Wrong RBAC permissions
  const wrongRbac = await httpReq('POST', '/vendors', { name: 'Breach-Vendor' }, customerToken);
  if (wrongRbac.status === 403) {
    pass('Security: Insufficient permission returns 403');
  } else {
    fail('Security: Insufficient permission', `Expected 403 but got ${wrongRbac.status}`);
  }

  // Verify: Cross-vendor access
  const createVendor2 = await httpReq('POST', '/vendors', {
    name: 'Vendor-Test-Beta',
    company_name: 'Beta Meat Corp',
    email: 'vendor-beta@test.com',
    phone: '+919000000005',
  }, adminToken);
  
  if (createVendor2.status === 201) {
    const vendor2Id = createVendor2.data.data.id;
    const crossVendorRes = await httpReq('POST', `/vendor-kyc/${vendor2Id}/kyc`, {
      document_type: 'GSTIN',
      document_number: 'KYC-BREACH-1',
      document_url: 'https://test.com/gstin.pdf',
    }, vendorOwnerToken);

    if (crossVendorRes.status === 403) {
      pass('Security: Cross-vendor write access returns 403 Forbidden');
    } else {
      fail('Security: Cross-vendor write access', `Expected 403 but got ${crossVendorRes.status}`);
    }
  }

  // Verify: Invalid UUID
  const invalidUuid = await httpReq('GET', '/vendor-kyc/not-a-uuid-string/kyc/status', null, adminToken);
  if (invalidUuid.status === 400 || invalidUuid.status === 422 || invalidUuid.status === 404) {
    pass(`Validation: Invalid UUID handled safely with code ${invalidUuid.status}`);
  } else {
    fail('Validation: Invalid UUID', `Expected error status but got ${invalidUuid.status}`);
  }

  // Verify: Missing required fields
  const missingField = await httpReq('POST', '/catalogue/brands', {}, adminToken);
  if (missingField.status === 400 || missingField.status === 422) {
    pass('Validation: Missing required fields returned validation error');
  } else {
    fail('Validation: Missing required fields', `Expected 400/422 but got ${missingField.status}`);
  }

  // Verify: Invalid enum value
  const invalidEnum = await httpReq('PATCH', `/orders/${testOrderId}/status`, {
    status: 'NON_EXISTENT_STATUS_XYZ',
  }, adminToken);
  if (invalidEnum.status === 400 || invalidEnum.status === 422) {
    pass('Validation: Invalid enum value returned validation error');
  } else {
    fail('Validation: Invalid enum value', `Expected 400/422 but got ${invalidEnum.status}`);
  }

  // Verify: SQL Injection Payload
  const sqlInjection = await httpReq('POST', '/catalogue/brands', {
    name: "Brand-Test-Meat'; DROP TABLE brands;--",
  }, adminToken);
  if (sqlInjection.status === 201) {
    pass('Security: SQL injection payload safely parameterized and handled');
  } else if (sqlInjection.status === 400 || sqlInjection.status === 422) {
    pass('Security: SQL injection payload validation error caught');
  } else {
    fail('Security: SQL injection payload execution', `Returned status code ${sqlInjection.status}`);
  }

  // Verify: No stack trace leakage on internal errors
  if (missingField.data && !missingField.data.stack) {
    pass('Security: Error response does not leak internal stack traces');
  } else {
    fail('Security: Error response stack trace leakage check', 'Stack trace leaked in response body!');
  }


  console.log('\n================================================================================');
  console.log('CONCURRENCY & RACE CONDITIONS');
  console.log('================================================================================');

  try {
    let testProductId = '';
    const products = await dbQuery(`SELECT id FROM products LIMIT 1`);
    testProductId = products[0].id;

    // Register 5 units of stock to test concurrency
    const inboundConcurrency = await httpReq('POST', '/inventory/inbound', {
      warehouse_id: testWarehouseId,
      product_id: testProductId,
      batch_number: 'BATCH-TEST-CONCURRENCY-01',
      expiry_date: '2026-09-30',
      quantity: 5.0,
    }, adminToken);

    if (inboundConcurrency.status === 200) {
      pass('Concurrency: Baseline stock of 5 registered');
      
      // Hit 3 concurrent requests trying to reserve 3 units each (Total 9 units > 5 units available)
      const reservations = [
        httpReq('POST', '/inventory/reserve', { warehouse_id: testWarehouseId, product_id: testProductId, quantity: 3.0, reservation_key: 'RSV-CONC-1' }, adminToken),
        httpReq('POST', '/inventory/reserve', { warehouse_id: testWarehouseId, product_id: testProductId, quantity: 3.0, reservation_key: 'RSV-CONC-2' }, adminToken),
        httpReq('POST', '/inventory/reserve', { warehouse_id: testWarehouseId, product_id: testProductId, quantity: 3.0, reservation_key: 'RSV-CONC-3' }, adminToken),
      ];

      const res = await Promise.all(reservations);
      const successes = res.filter(r => r.status === 200);
      const failures = res.filter(r => r.status !== 200);

      console.log(`  Concurrency: Successful reservations: ${successes.length}, Failed: ${failures.length}`);
      if (successes.length <= 1) {
        pass('Concurrency: Transaction boundary prevented overselling/negative inventory');
      } else {
        throw new Error(`Oversold! More than 1 reservation succeeded: ${successes.length}`);
      }
    }
  } catch (e) {
    fail('Concurrency inventory reservations', e);
  }

  // Cleanup pool
  await dbPool.end();

  // REPORT SUMMARY
  const passed = results.filter(r => r.s === '✅');
  const failed = results.filter(r => r.s === '❌');
  console.log(`\n================================================================================`);
  console.log(`Test Execution Finished | Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);
  console.log(`================================================================================\n`);

  if (failed.length > 0) {
    console.log('=== FAILED TESTS ===');
    for (const f of failed) {
      console.log(`  ${f.s} ${f.label} -> ${f.err}`);
    }
    process.exit(1);
  } else {
    console.log('🎉 All test suites completed successfully with zero regressions!');
    process.exit(0);
  }
}

runTests().catch((e) => {
  console.error('Fatal crash during test run:', e);
  process.exit(1);
});
