const { Pool } = require('pg');
const pool = new Pool();
const shortterm = require('../modules/shortterm');
const emotions = require('../modules/emotions');
const goals = require('../modules/goals');
const identity = require('../modules/identity');

module.exports = async function syncToPostgres() {
  const state = await shortterm.read();
  state.emotions = await emotions.read();
  state.goals = await goals.read();
  state.identity = await identity.read();
  for (const [key, value] of Object.entries(state)) {
    await pool.query(
      `INSERT INTO memory (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)]
    );
  }
  return { success: true };
};
