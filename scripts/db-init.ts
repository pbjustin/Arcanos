import { Pool } from 'pg';
import { TABLE_DEFINITIONS } from '../src/db/schema.js';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function ensureSchema() {
  console.log("🔍 Checking database schema...");

  try {
    for (const query of TABLE_DEFINITIONS) {
      // Basic check: we just run the query. The definitions are idempotent (IF NOT EXISTS).
      // If a more complex migration system is needed, we should implement versioning.
      // For now, this matches the behavior of "ensure tables exist".
      
      // We log the attempt for visibility
      const tableNameMatch = query.match(/CREATE TABLE IF NOT EXISTS (\w+)/);
      const tableName = tableNameMatch ? tableNameMatch[1] : 'index/other';
      
      try {
        await pool.query(query);
        console.log(`✅ Processed schema for: ${tableName}`);
      } catch (err: any) {
         console.warn(`⚠️  Warning processing ${tableName}: ${err.message}`);
         // We continue, as some queries might be "ALTER TABLE" which fail if exists, etc.
      }
    }

    console.log("✅ Database schema verification complete.");
  } catch (err) {
    console.error("❌ Error ensuring schema:", err);
    process.exit(1); 
  }
}

if (require.main === module) {
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
