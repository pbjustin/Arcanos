const { Pool } = require('pg');

let pool = null;
let memoryFallback = null;

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
  console.warn('DATABASE_URL not set for memory module; falling back to in-memory store');
  memoryFallback = new Map();
}

module.exports = {
  route: '/memory',
  description: 'Database-backed key-value store',
  async handler(payload) {
    if (payload.action === 'set') {
      if (pool) {
        await pool.query(
          `INSERT INTO memory_store (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [payload.key, JSON.stringify(payload.value)]
        );
      } else {
        memoryFallback.set(payload.key, payload.value);
      }
      return { status: 'stored', key: payload.key, value: payload.value };
    }
    if (payload.action === 'get') {
      if (pool) {
        const { rows } = await pool.query(
          'SELECT value FROM memory_store WHERE key = $1',
          [payload.key]
        );
        return { key: payload.key, value: rows[0] ? rows[0].value : null };
      } else {
        return { key: payload.key, value: memoryFallback.get(payload.key) ?? null };
      }
    }
    return { error: 'Invalid action' };
  },
  async handle(payload) {
    return this.handler(payload);
  }
};
