import OpenAI from 'openai';
import pkg from 'pg';
import dotenv from 'dotenv';

const { Pool } = pkg;

// Load environment variables from .env if available
dotenv.config();

// Initialize OpenAI client (will throw if key missing when called)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Initialize PG pool if DATABASE_URL provided
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

/**
 * Fetches an entry from the memory_states table by key.
 * @param {string} entryKey
 * @returns {Promise<any|null>} entry_data or null if not found
 */
export async function fetchDBEntry(entryKey) {
  if (!pool) {
    console.warn('[WARN] DATABASE_URL not set; skipping DB lookup');
    return null;
  }

  const result = await pool.query(
    'SELECT entry_data FROM memory_states WHERE entry_key = $1',
    [entryKey]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].entry_data;
}

/**
 * Generates a player-friendly build guide tagged with [DB] and [AI].
 * @param {string} entryKey
 * @returns {Promise<string>} guide text
 */
export async function generateTaggedGuide(entryKey) {
  const dbEntry = await fetchDBEntry(entryKey);

  const response = await openai.chat.completions.create({
    model: process.env.AI_MODEL || 'REDACTED_FINE_TUNED_MODEL_ID',
    messages: [
      {
        role: 'system',
        content:
          'You are ARCANOS Gaming Guide Generator. Validate against DB first. Tag all outputs with [DB] (from database) or [AI] (inferred reasoning).',
      },
      {
        role: 'user',
        content: `DB Entry: ${JSON.stringify(dbEntry)}\n\nGenerate a player-friendly build guide.`,
      },
    ],
  });

  return response.choices[0].message.content;
}

// Allow running from CLI: `node scripts/generate-tagged-guide.js <entry_key>`
if (import.meta.url === `file://${process.argv[1]}`) {
  const entryKey = process.argv[2];
  if (!entryKey) {
    console.error('Usage: node scripts/generate-tagged-guide.js <entry_key>');
    process.exit(1);
  }

  generateTaggedGuide(entryKey)
    .then((guide) => {
      console.log('🧠 Tagged Guide:\n', guide);
    })
    .catch((err) => {
      console.error('Error generating guide:', err.message);
    })
    .finally(() => {
      if (pool) pool.end();
    });
}
