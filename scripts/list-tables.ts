import { Pool } from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Create a pool instead of a single client
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false // Railway internal DB doesn't require SSL
});

// Example function to list all tables
export async function listAllTables() {
  const query = `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
    ORDER BY table_schema, table_name;
  `;

  let client;
  try {
    client = await pool.connect(); // Always get a fresh, live connection
    const res = await client.query(query);
    console.log('Tables in database:', res.rows);
    return res.rows;
  } catch (err) {
    console.error('Error fetching tables:', err);
    throw err;
  } finally {
    if (client) client.release(); // Release back to pool
  }
}

// Run the example if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  listAllTables()
    .catch((err) => {
      console.error(err);
    })
    .finally(async () => {
      await pool.end();
      process.exit(0);
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  await pool.end();
  process.exit(0);
});
