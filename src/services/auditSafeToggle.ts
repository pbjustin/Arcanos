/**
 * ARCANOS Audit-Safe Toggle Manager
 * ---------------------------------
 * Modes:
 *   - "true"    → strict enforcement
 *   - "false"   → disabled
 *   - "passive" → logs only, no blocking
 *   - "log-only" → logs events without validation warnings
 *
 * Compatible with OpenAI SDK (chat/completions).
 */

import { getOpenAIClient, getDefaultModel } from './openai.js';

let auditSafeMode: 'true' | 'false' | 'passive' | 'log-only' = 'true'; // default mode

export function setAuditSafeMode(mode: 'true' | 'false' | 'passive' | 'log-only') {
  if (!['true', 'false', 'passive', 'log-only'].includes(mode)) {
    throw new Error("Invalid mode. Use 'true', 'false', 'passive', or 'log-only'.");
  }
  auditSafeMode = mode;
  console.log(`🔐 Audit-Safe mode set to: ${auditSafeMode}`);
}

export function getAuditSafeMode(): 'true' | 'false' | 'passive' | 'log-only' {
  return auditSafeMode;
}

// Example persistence handler with Audit-Safe awareness
export function saveWithAuditCheck<T>(data: T, validator: (data: T) => boolean): T {
  const mode = getAuditSafeMode();

  if (mode === 'true') {
    if (!validator(data)) {
      throw new Error('❌ Audit-Safe rejected invalid data.');
    }
    console.log('✅ Audit-Safe validation passed.');
    return data;
  }

  if (mode === 'passive') {
    console.warn('⚠️ Audit-Safe passive mode: logging only.');
    if (!validator(data)) {
      console.warn('⚠️ Invalid data would have been blocked in strict mode.');
    }
    return data;
  }

  if (mode === 'log-only') {
    console.log('📝 Audit-Safe log-only mode: events logged without validation.');
    if (!validator(data)) {
      console.log('📝 Invalid data logged without blocking.');
    }
    return data;
  }

  // mode === 'false'
  console.log('🚨 Audit-Safe disabled. Writing without check.');
  return data;
}

export async function interpretCommand(userCommand: string) {
  const client = getOpenAIClient();
  if (!client) {
    console.warn('⚠️ OpenAI client not available - using mock response for command interpretation');
    // Provide simple command mapping when API is not available
    const normalized = userCommand.toLowerCase();
    if (normalized.includes('strict') || normalized.includes('true') || normalized.includes('enable')) {
      setAuditSafeMode('true');
    } else if (normalized.includes('false') || normalized.includes('disable')) {
      setAuditSafeMode('false');
    } else if (normalized.includes('passive')) {
      setAuditSafeMode('passive');
    } else if (normalized.includes('log')) {
      setAuditSafeMode('log-only');
    } else {
      console.warn('⚠️ Unrecognized command. Mode unchanged.');
    }
    return;
  }

  try {
    const response = await client.chat.completions.create({
      model: getDefaultModel(),
      messages: [
        { role: 'system', content: 'You are an AI that maps natural language commands to audit-safe mode toggles.' },
        { role: 'user', content: userCommand }
      ]
    });

    const raw = response.choices[0].message?.content?.trim().toLowerCase();
    const mode = raw as 'true' | 'false' | 'passive' | 'log-only' | undefined;

    if (mode && ['true', 'false', 'passive', 'log-only'].includes(mode)) {
      setAuditSafeMode(mode);
    } else {
      console.warn('⚠️ Unrecognized command. Mode unchanged.');
    }
  } catch (error) {
    console.error('❌ Error interpreting command:', error instanceof Error ? error.message : 'Unknown error');
    console.warn('⚠️ Command interpretation failed. Mode unchanged.');
  }
}

export default {
  setAuditSafeMode,
  getAuditSafeMode,
  saveWithAuditCheck,
  interpretCommand,
};
