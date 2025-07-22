const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const pool = new Pool(); // assumes DATABASE_URL env is set

module.exports = async function bootstrapMemory() {
  const sqlPath = path.resolve(__dirname, '../state/memory_state.sql');

  if (!fs.existsSync(sqlPath)) {
    return { error: 'memory_state.sql not found.' };
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  try {
    await pool.query(sql);
    return { success: true, message: 'Memory schema initialized.' };
  } catch (err) {
    return { error: err.message };
  }
};
