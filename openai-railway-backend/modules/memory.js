const { Pool } = require('pg');

let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  (async () => {
    try {
      await pool.query(
        `CREATE TABLE IF NOT EXISTS memory_store (
          key TEXT PRIMARY KEY,
          value JSONB
        )`
      );
    } catch (err) {
      console.error('Failed to initialize memory_store table', err);
    }
  })();
} else {
  console.warn('DATABASE_URL not set for memory module');
}

module.exports = {
  route: '/memory',
  description: 'Database-backed key-value store',
  async handler(payload) {
    if (!pool) {
      throw new Error('DATABASE_URL not configured');
    }
    if (payload.action === 'set') {
      await pool.query(
        `INSERT INTO memory_store (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [payload.key, JSON.stringify(payload.value)]
      );
      return { status: 'stored', key: payload.key, value: payload.value };
    }
    if (payload.action === 'get') {
      const { rows } = await pool.query(
        'SELECT value FROM memory_store WHERE key = $1',
        [payload.key]
      );
      return { key: payload.key, value: rows[0] ? rows[0].value : null };
    }
    return { error: 'Invalid action' };
  },
  async handle(payload) {
    return this.handler(payload);
  }
};
