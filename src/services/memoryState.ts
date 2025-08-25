/**
 * Memory State Service
 * Registers, retrieves, and validates memory state entries.
 */

import { query } from '../db.js';
import { getOpenAIClient } from './openai.js';

/**
 * Register or update memory state in PostgreSQL
 */
export async function syncMemoryState(
  entryKey: string,
  entryData: unknown,
  stateVersion = '1.174'
): Promise<void> {
  await query(
    `INSERT INTO memory_states (entry_key, entry_data, state_version, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (entry_key)
     DO UPDATE SET entry_data = EXCLUDED.entry_data, state_version = EXCLUDED.state_version, updated_at = NOW()`,
    [entryKey, JSON.stringify(entryData), stateVersion]
  );
  console.log(`✅ Synced memory entry: ${entryKey} → version ${stateVersion}`);
}

/**
 * Retrieve memory state with version control
 */
export async function getMemoryState(
  entryKey: string
): Promise<{ entry_data: any; state_version: string } | null> {
  const result = await query(
    `SELECT entry_data, state_version FROM memory_states WHERE entry_key = $1`,
    [entryKey]
  );

  if (result.rows.length === 0) {
    console.log(`⚠️ No entry found for ${entryKey}`);
    return null;
  }

  const { entry_data, state_version } = result.rows[0];
  console.log(`📦 Retrieved memory entry: ${entryKey} (version ${state_version})`);
  return { entry_data, state_version };
}

/**
 * Validate memory state via GPT
 */
export async function validateMemory(
  entryKey: string,
  entryData: any,
  stateVersion: string
): Promise<string> {
  const client = getOpenAIClient();
  if (!client) {
    console.warn('⚠️ OpenAI client not available - returning mock validation');
    return 'OpenAI client unavailable';
  }

  const response = await client.chat.completions.create({
    model: 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote',
    messages: [
      { role: 'system', content: 'You are ARCANOS Memory Validator. Ensure consistent state across GPT chats.' },
      { role: 'user', content: `Entry Key: ${entryKey}\nVersion: ${stateVersion}\nData: ${JSON.stringify(entryData)}` }
    ]
  });

  const validation = response.choices[0]?.message?.content || '';
  console.log('🧠 Memory Validation Result:', validation);
  return validation;
}

