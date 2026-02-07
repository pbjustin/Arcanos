/**
 * Memory State Service
 * Registers, retrieves, and validates memory state entries.
 */

import { query } from '../db/index.js';
import { getDefaultModel } from './openai.js';
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { buildMemoryValidationMessages } from '../utils/memoryValidationMessages.js';

/**
 * Register or update memory state in PostgreSQL.
 * Inputs: entryKey (string), entryData (unknown), stateVersion (string, optional).
 * Outputs: resolves once state is persisted.
 * Edge cases: overwrites existing entries with same key.
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
 * Retrieve memory state with version control.
 * Inputs: entryKey (string).
 * Outputs: memory state row or null when missing.
 * Edge cases: returns null if no matching entry exists.
 */
export async function getMemoryState(
  entryKey: string
): Promise<{ entry_data: unknown; state_version: string } | null> {
  const result = await query(
    `SELECT entry_data, state_version FROM memory_states WHERE entry_key = $1`,
    [entryKey]
  );

  //audit Assumption: missing rows indicate no entry; risk: upstream callers assume data exists; invariant: empty result implies absence; handling: return null.
  if (result.rows.length === 0) {
    console.log(`⚠️ No entry found for ${entryKey}`);
    return null;
  }

  const { entry_data, state_version } = result.rows[0];
  console.log(`📦 Retrieved memory entry: ${entryKey} (version ${state_version})`);
  return { entry_data, state_version };
}

/**
 * Validate memory state via GPT.
 * Inputs: entryKey (string), entryData (unknown), stateVersion (string).
 * Outputs: validation message from the model or fallback string.
 * Edge cases: returns fallback string when adapter is unavailable.
 */
export async function validateMemory(
  entryKey: string,
  entryData: unknown,
  stateVersion: string
): Promise<string> {
  const { adapter } = getOpenAIClientOrAdapter();
  if (!adapter) {
    //audit Assumption: missing adapter should return fallback; risk: validation is skipped; invariant: callers receive explicit fallback text; handling: return fallback string.
    console.warn('⚠️ OpenAI adapter not available - returning mock validation');
    return 'OpenAI adapter unavailable';
  }

  const response = await adapter.chat.completions.create({
    model: getDefaultModel(),
    messages: buildMemoryValidationMessages(entryKey, stateVersion, entryData)
  });

  const validation = response.choices[0]?.message?.content || '';
  console.log('🧠 Memory Validation Result:', validation);
  return validation;
}
