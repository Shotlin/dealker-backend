import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'grocery_user',
  password: 'grocery_password_dev',
  database: 'grocery_db'
});

async function run() {
  try {
    const orderRes = await pool.query('SELECT id, order_number, status, created_at FROM orders ORDER BY created_at DESC LIMIT 3');
    console.log('\n--- LATEST 3 ORDERS ---');
    console.table(orderRes.rows.map(r => ({...r, id: r.id.slice(0, 8)})));
    
    if (orderRes.rows.length > 0) {
        const orderId = orderRes.rows[0].id;
        const assignRes = await pool.query('SELECT id, order_id, rider_id, status FROM delivery_assignments WHERE order_id = $1', [orderId]);
        console.log(`\n--- ASSIGNMENTS FOR LATEST ORDER (${orderRes.rows[0].order_number}) ---`);
        console.table(assignRes.rows.map(r => ({...r, id: r.id.slice(0, 8), order: r.order_id.slice(0,8), rider: r.rider_id?.slice(0,8)})));
    }
    
    const riderRes = await pool.query('SELECT rp.user_id, rp.is_online, rp.is_approved FROM rider_profiles rp JOIN users u ON u.id = rp.user_id LIMIT 3');
    console.log('\n--- RIDER PROFILES ONLINE STATUS ---');
    console.table(riderRes.rows.map(r => ({...r, user_id: r.user_id.slice(0, 8)})));

  } catch(e) {
    console.error("DB Error:", e.message);
  } finally {
    await pool.end();
  }
}
run();
