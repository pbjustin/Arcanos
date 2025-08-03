import { Pool } from 'pg';
import shortterm from '../modules/shortterm.js';
import emotions from '../modules/emotions.js';
import goals from '../modules/goals.js';
import identity from '../modules/identity.js';

const pool = new Pool();

export default async function syncToPostgres() {
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
}
