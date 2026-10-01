import { getConfig } from "@platform/runtime/unifiedConfig.js";

const OPENAI_KEY_PLACEHOLDERS = new Set([
  '',
  'your-openai-api-key-here',
  'your-openai-key-here',
  'mock-api-key',
  'sk-mock-for-ci-testing'
]);

let resolvedApiKey: string | null | undefined;
let resolvedApiKeySource: string | null = null;

function isPlaceholderOpenAIKey(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  return OPENAI_KEY_PLACEHOLDERS.has(trimmed) || trimmed.startsWith('sk-mock-');
}

export type GenerativeModelRole =
  | 'intake' | 'reasoning' | 'final' | 'final-escalation' | 'audit' | 'audit-escalation';

/** Policy failures are safe to classify at HTTP boundaries without exposing configured IDs. */
export class GenerativeModelPolicyError extends Error {
  constructor(public readonly code: 'MODEL_OVERRIDE_CONFLICT' | 'FINAL_AUTHORITY_UNAVAILABLE', role: GenerativeModelRole) {
    super(code === 'MODEL_OVERRIDE_CONFLICT'
      ? `Generative model policy: model override conflicts with ${role} role`
      : `Generative model policy: configured fine-tune authority unavailable for ${role}`);
    this.name = 'GenerativeModelPolicyError';
  }
}

/** Resolve a backend generation role; conflicting caller models fail before transport. */
export function resolveGenerativeModel(role: GenerativeModelRole, requestedModel?: string): string {
  const config = getConfig();
  const models: Record<GenerativeModelRole, string> = {
    intake: config.trinityIntakeModel,
    reasoning: config.trinityReasoningModel,
    final: config.trinityFinalModel,
    'final-escalation': config.trinityFinalEscalationModel,
    audit: config.clearAuditModel,
    'audit-escalation': config.clearAuditEscalationModel
  };
  const model = models[role]?.trim();
  //audit Never substitute a helper or historical fine-tune for this service's authority.
  if (!model || ((role === 'final' || role === 'final-escalation') && !/^ft:[^\s]+$/.test(model))) {
    throw new GenerativeModelPolicyError('FINAL_AUTHORITY_UNAVAILABLE', role);
  }
  //audit Explicit model parameters can confirm a role but cannot independently select its model.
  if (requestedModel !== undefined && requestedModel.trim() !== model) {
    throw new GenerativeModelPolicyError('MODEL_OVERRIDE_CONFLICT', role);
  }
  return model;
}

export function resolveOpenAIBaseURL(): string | undefined {
  const appConfig = getConfig();
  return appConfig.openaiBaseUrl;
}

export function resolveOpenAIKey(): string | null {
  // Only use cache when we have a valid key; re-check env when we had none (handles late .env load or deployment vars)
  if (resolvedApiKey !== undefined && resolvedApiKey !== null) {
    return resolvedApiKey;
  }

  // Get from config (config layer handles env access)
  const appConfig = getConfig();
  const apiKey = appConfig.openaiApiKey;

  if (!apiKey) {
    resolvedApiKeySource = null;
    return null;
  }

  const trimmed = apiKey.trim();
  //audit Assumption: CI and local test placeholder keys should never trigger live OpenAI calls; failure risk: deterministic test workflows attempt real network auth and fail noisily; expected invariant: mock/test sentinel keys are treated as missing credentials; handling strategy: reject known placeholders and mock-key prefixes.
  if (isPlaceholderOpenAIKey(trimmed)) {
    resolvedApiKeySource = null;
    return null;
  }

  resolvedApiKey = trimmed;
  resolvedApiKeySource = 'OPENAI_API_KEY'; // Config layer resolves this
  return resolvedApiKey;
}

export function getOpenAIKeySource(): string | null {
  return resolvedApiKeySource;
}

export function resetCredentialCache(): void {
  resolvedApiKey = undefined;
  resolvedApiKeySource = null;
}

export function hasValidAPIKey(): boolean {
  return resolveOpenAIKey() !== null;
}

export function setDefaultModel(model: string): void {
  // Compatibility seam validates authority instead of replacing service configuration.
  resolveGenerativeModel('final', model);
}

export function getDefaultModel(): string {
  return resolveGenerativeModel('final');
}

export function getFallbackModel(): string {
  return resolveGenerativeModel('final-escalation');
}

/** Complex final composition retains the configured fine-tune authority. */
export function getComplexModel(): string {
  return resolveGenerativeModel('final-escalation');
}

/**
 * Compatibility selector for structured reasoning helpers; final callers use the final role.
 */
export function getGPT5Model(): string {
  return resolveGenerativeModel('reasoning');
}

/** Dedicated model selector for Trinity's structured Responses reasoning stage. */
export function getTrinityReasoningModel(): string {
  return resolveGenerativeModel('reasoning');
}

/** Lightweight intake is shared across backend modules. */
export function getTrinityIntakeModel(): string {
  return resolveGenerativeModel('intake');
}

export function getTrinityFinalModel(): string {
  return resolveGenerativeModel('final');
}

export function getTrinityFinalEscalationModel(): string {
  return resolveGenerativeModel('final-escalation');
}

export function getClearAuditModel(): string {
  return resolveGenerativeModel('audit');
}

export function getClearAuditEscalationModel(): string {
  return resolveGenerativeModel('audit-escalation');
}
