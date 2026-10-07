import pg from 'pg';
import { createClient } from 'redis';

const pool = new pg.Pool({
  connectionString: 'postgresql://grocery_user:grocery_password_dev@localhost:5432/grocery_db'
});

const redisClient = createClient({ url: 'redis://localhost:6379' });

async function main() {
  await redisClient.connect();

  // Flush all warehouse-active cache keys
  const keys = await redisClient.keys('meet-commerce:warehouse-active:v1:*');
  console.log('Found warehouse cache keys:', keys);
  if (keys.length > 0) {
    await redisClient.del(keys);
    console.log('Deleted stale warehouse cache keys');
  }

  // Verify warehouse status in DB
  const res = await pool.query('SELECT id, name, code, is_active FROM warehouses');
  console.log('Warehouses in DB:');
  console.table(res.rows);

  await redisClient.quit();
  await pool.end();
  console.log('Done');
}

main().catch(console.error);
