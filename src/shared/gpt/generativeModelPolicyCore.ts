export type GenerativeModelRole =
  | 'intake' | 'reasoning' | 'final' | 'final-escalation' | 'audit' | 'audit-escalation';

/** Explicit role configuration; this core never reads environment or provider state. */
export interface GenerativeModelRoleConfig {
  trinityIntakeModel: string;
  trinityReasoningModel: string;
  trinityFinalModel: string;
  trinityFinalEscalationModel: string;
  clearAuditModel: string;
  clearAuditEscalationModel: string;
}

/** Policy failures are safe to classify at HTTP boundaries without exposing configured IDs. */
export class GenerativeModelPolicyError extends Error {
  constructor(public readonly code: 'MODEL_OVERRIDE_CONFLICT' | 'FINAL_AUTHORITY_UNAVAILABLE', role: GenerativeModelRole) {
    super(code === 'MODEL_OVERRIDE_CONFLICT'
      ? `Generative model policy: model override conflicts with ${role} role`
      : `Generative model policy: configured fine-tune authority unavailable for ${role}`);
    this.name = 'GenerativeModelPolicyError';
  }
}

/** Resolve an explicit generation role before transport, preserving the service's authority. */
export function resolveGenerativeModelFromConfig(
  config: GenerativeModelRoleConfig,
  role: GenerativeModelRole,
  requestedModel?: string
): string {
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

const normalizeModelId = (model: string): string => model.trim().toLowerCase();

/** Require exact fine-tune identity or a matching helper model family in raw replies. */
export function assertGenerativeModelResponseIdentity(response: { model?: unknown }, expectedModel: string): string {
  const actualModel = typeof response?.model === 'string' ? response.model.trim() : '';

  //audit Assumption: response must include model identifier; risk: downstream mismatches; invariant: non-empty model id; handling: throw explicit error.
  if (!actualModel) {
    throw new Error(`GPT-5.1 reasoning response did not include a model identifier. Expected '${expectedModel}'.`);
  }

  const normalizedActual = normalizeModelId(actualModel);
  const normalizedExpected = normalizeModelId(expectedModel);
  const matchesExpected = normalizedExpected.startsWith('ft:')
    ? actualModel === expectedModel.trim()
    : normalizedActual === normalizedExpected || (
      normalizedActual.startsWith(`${normalizedExpected}-`) ||
      normalizedActual.startsWith(`${normalizedExpected}.`)
    );

  //audit Assumption: model should match expected prefix; risk: unexpected model usage; invariant: prefix match or exact match; handling: throw explicit error.
  if (!matchesExpected) {
    throw new Error(
      `GPT-5.1 reasoning response used unexpected model '${actualModel}'. Expected model to start with '${expectedModel}'.`,
    );
  }
  return actualModel;
}
