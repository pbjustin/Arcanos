import { type DispatchRegistryAction } from './types.js';

const UNSAFE_GPT_ACCESS_PAYLOAD_KEY_NAMES = [
  '__arcanosExecutionMode',
  '__arcanosExecutionReason',
  '__arcanosGptId',
  '__arcanosRequestedAction',
  '__arcanosSourceEndpoint',
  '__arcanosSuppressPromptDebugTrace',
  '__proto__',
  'admin_key',
  'api-key',
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'command',
  'constructor',
  'cookie',
  'cookies',
  'endpoint',
  'exec',
  'headers',
  'maxOutputTokens',
  'maxWords',
  'openai_api_key',
  'overrideAuditSafe',
  'password',
  'prototype',
  'proxy',
  'railway_token',
  'secret',
  'shell',
  'sql',
  'suppressTimeoutFallback',
  'target',
  'timeout_ms',
  'timeoutMs',
  'token',
  'url'
];

const LLM_DISPATCH_CONTROL_PAYLOAD_KEY_NAMES = [
  'risk',
  'runner',
  'scope'
];

export const UNSAFE_GPT_ACCESS_PAYLOAD_KEYS = new Set(
  UNSAFE_GPT_ACCESS_PAYLOAD_KEY_NAMES.map(normalizePayloadKey)
);

const LLM_DISPATCH_CONTROL_PAYLOAD_KEYS = new Set(
  LLM_DISPATCH_CONTROL_PAYLOAD_KEY_NAMES.map(normalizePayloadKey)
);

export function normalizePayloadKey(value: string): string {
  return value.toLowerCase().replace(/[\s._-]+/gu, '');
}

function normalizePayloadKeyForControlPrefix(value: string): string {
  return value.toLowerCase().replace(/[\s.-]+/gu, '');
}

export function isUnsafeGptAccessPayloadKey(key: string): boolean {
  const normalized = normalizePayloadKey(key);
  return (
    UNSAFE_GPT_ACCESS_PAYLOAD_KEYS.has(normalized)
    || normalizePayloadKeyForControlPrefix(key).startsWith('__arcanos')
  );
}

export function isUnsafeLlmDispatchPayloadKey(key: string): boolean {
  return isUnsafeGptAccessPayloadKey(key) || LLM_DISPATCH_CONTROL_PAYLOAD_KEYS.has(normalizePayloadKey(key));
}

export function dispatchActionRequiresConfirmation(
  registryAction: DispatchRegistryAction,
  planRequiresConfirmation = false
): boolean {
  return Boolean(
    planRequiresConfirmation
    || registryAction.requiresConfirmation
    || registryAction.risk !== 'readonly'
  );
}
