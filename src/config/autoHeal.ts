export const AUTO_HEAL_TOKEN_LIMIT = 1200;

export const AUTO_HEAL_RECOMMENDED_ACTIONS = [
  'monitor',
  'restart-workers',
  'fallback-model',
  'escalate'
] as const;

export const AUTO_HEAL_SEVERITY_LEVELS = ['ok', 'warning', 'critical'] as const;

const AUTO_HEAL_PROMPT_TEMPLATE = [
  'You are ARCANOS reliability control operating on fine-tuned model {{model}}.',
  'Analyze the worker status JSON and produce recovery guidance in JSON with fields planId, severity, recommendedAction,',
  'message, steps (array), and fallbackModel.',
  'Recommended actions must be one of monitor, restart-workers, fallback-model, or escalate.',
  'JSON input:',
  '{{payload}}'
].join('\n');

export function buildAutoHealPrompt(model: string, payload: unknown): string {
  return AUTO_HEAL_PROMPT_TEMPLATE.replace('{{model}}', model).replace('{{payload}}', JSON.stringify(payload));
}
