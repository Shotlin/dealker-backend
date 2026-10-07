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
    await pool.query("UPDATE rider_profiles SET rating = 5.0, total_deliveries = 999 WHERE user_id = (SELECT id FROM users WHERE phone = '9775845587')");
    await pool.query("UPDATE rider_profiles SET rating = 5.0, total_deliveries = 1000 WHERE user_id = (SELECT id FROM users WHERE phone = '6297831930')");
    console.log("Updated ratings for Sayan's accounts.");
  } catch(e) {
    console.error(e.message);
  } finally { pool.end(); }
}
run();
