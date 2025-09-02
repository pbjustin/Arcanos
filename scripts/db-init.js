import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureSchema() {
  console.log("🔍 Checking database schema...");

  // List of required tables and their creation SQL
  const requiredTables = {
    saves: `
      CREATE TABLE IF NOT EXISTS saves (
        id SERIAL PRIMARY KEY,
        module TEXT NOT NULL,
        data JSONB NOT NULL,
        timestamp BIGINT NOT NULL
      );
    `,
    audit_logs: `
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        event TEXT NOT NULL,
        payload JSONB,
        timestamp BIGINT NOT NULL
      );
    `
    // add more tables here as needed
  };

  try {
    for (const [table, createSQL] of Object.entries(requiredTables)) {
      const res = await pool.query(
        `SELECT to_regclass($1) AS exists;`,
        [table]
      );

      if (!res.rows[0].exists) {
        console.log(`⚠️  Table "${table}" is missing. Creating...`);
        await pool.query(createSQL);
        console.log(`✅ Table "${table}" created successfully.`);
      } else {
        console.log(`✔️  Table "${table}" already exists.`);
      }
    }

    console.log("✅ Database schema verification complete.");
  } catch (err) {
    console.error("❌ Error ensuring schema:", err);
    process.exit(1); // exit if DB is unreachable
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureSchema()
    .catch(err => {
      console.error(err);
    })
    .finally(async () => {
      await pool.end();
      process.exit(0);
    });
}

export default ensureSchema;
