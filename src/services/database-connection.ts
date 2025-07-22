// 🧠 Copilot Instruction: Fix database by connecting to PostgreSQL and ensuring memory table exists
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL not set — memory service will use fallback');
  // Create a module that provides fallback functionality instead of exiting
  const fallbackPool = {
    query: async () => {
      throw new Error('Database not configured - set DATABASE_URL environment variable');
    },
    end: async () => {},
    connect: async () => {
      throw new Error('Database not configured - set DATABASE_URL environment variable');
    }
  };
  export default fallbackPool;
} else {
  const pool = new Pool({ connectionString: DATABASE_URL });

  async function initDatabase() {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS memory (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL
        );
      `);
      console.log('✅ Connected to PostgreSQL and ensured memory table');
    } catch (error: any) {
      console.error('❌ Failed to connect to PostgreSQL:', error.message);
      process.exit(1);
    }
  }

  initDatabase();

  export default pool;
}