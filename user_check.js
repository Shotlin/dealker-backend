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
        const res = await pool.query(`
      SELECT rp.user_id, u.name, u.phone, rp.is_online, rp.rating, rp.total_deliveries
      FROM rider_profiles rp
      JOIN users u ON u.id = rp.user_id
      WHERE rp.is_online = true
      ORDER BY rp.rating DESC, rp.total_deliveries DESC
    `);
        console.table(res.rows.map(r => ({ ...r, user_id: r.user_id.slice(0, 8) })));
    } catch (e) {
        console.error(e.message);
    } finally { pool.end(); }
}
run();
