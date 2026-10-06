import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { configureLiveValidationModelRuntime } from '../scripts/start-live-validation-runtime.mjs';
import { createLiveValidationProvider } from '../scripts/live-validation-provider.mjs';
import { LIVE_VALIDATION_BUDGET_CAPS, LIVE_VALIDATION_TOKEN_LIMITS } from '../scripts/live-validation-budget.mjs';
import { createOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { runIntakeStage, runReasoningStage, runFinalStage, validateModel } from '../src/core/logic/trinityStages.js';
import { createRuntimeBudgetWithLimit } from '../src/platform/resilience/runtimeBudget.js';
import { writeRuntimeEnv } from '../src/platform/runtime/env.js';
import { logger } from '../src/platform/logging/structuredLogging.js';
import { runGamingClearAnswerAudit } from '../src/services/gamingClearAnswerAudit.js';
import { createGamingClearAssessment, gamingClearContextFingerprint, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';

const authority = 'ft:gpt-4.1:synthetic:validation-authority';
const refs = ['source-1', 'revision-1', 'chunk-1'];
const text = 'Lantern Vale: after restoring the Tide Hall pump, turn the west valve to open the return route.';
const answer = 'Turn the west valve to open the return route. [1]';
const dimensions = () => Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
  { status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED'], evidenceRefs: refs, unresolvedFacts: [] }
])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'];
const flags = {
  canBrowse: false, canVerifyProvidedData: true, canVerifyLiveData: false,
  canConfirmExternalState: false, canPersistData: false, canCallBackend: false
};
const controls = { strictUserVisibleOutput: true };
const environmentNames = ['AI_MODEL', 'FINETUNED_MODEL_ID', 'FINE_TUNED_MODEL_ID', 'OPENAI_MODEL',
  'RAILWAY_OPENAI_MODEL', 'TRINITY_REASONING_MAX_OUTPUT_TOKENS', 'OPENAI_STORE'];
let previousEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  previousEnvironment = Object.fromEntries(environmentNames.map(name => [name, process.env[name]]));
  for (const name of environmentNames) delete process.env[name];
  process.env.OPENAI_STORE = 'false';
  jest.spyOn(logger, 'info').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  jest.restoreAllMocks();
});

describe('real Trinity model allocations through the live-validation paid guard', () => {
  it('overrides the normal 8,000-token reasoning allocation and reaches the mandatory audit within the 4,096-token cap', async () => {
    process.env.TRINITY_REASONING_MAX_OUTPUT_TOKENS = '8000';
    configureLiveValidationModelRuntime(authority, writeRuntimeEnv);
    const observation = { moduleId: 'gaming', stage: 'generation' };
    const payloads: Array<Record<string, any>> = [];
    const provider = createLiveValidationProvider({
      apiKey: 'sk-unit-test-fixture-' + 'x'.repeat(40),
      identity: { sourceCommit: 'a'.repeat(40), deploymentId: '11111111-1111-4111-8111-111111111111' },
      target: { limits: LIVE_VALIDATION_BUDGET_CAPS,
        models: [authority, 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 2 })) },
      observation: () => observation,
      fetchImplementation: async (url: string, init: RequestInit) => {
        if (init.method === 'GET') return Response.json({ id: decodeURIComponent(url.split('/').at(-1)!), object: 'model' });
        const payload = JSON.parse(init.body as string);
        payloads.push(payload);
        const output = observation.stage === 'answer_audit' ? JSON.stringify({ dimensions: dimensions(), findings: [] })
          : payload.text?.format?.type === 'json_schema' ? JSON.stringify({ response_mode: 'answer',
            achievable_subtasks: [], blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: answer })
            : answer;
        return Response.json({ id: 'offline-response', object: 'response', model: payload.model, status: 'completed',
          created_at: 1, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output, annotations: [] }] }] });
      }
    });
    try {
      const client = createOpenAIAdapter({ apiKey: 'validation-provider-placeholder', maxRetries: 0,
        baseURL: 'https://api.openai.com/v1', fetch: provider.fetch }).getClient();
      const budget = createRuntimeBudgetWithLimit(30_000, 0);
      provider.beginWorkflow('gaming-guide-positive');
      const intakeModel = await validateModel(client, budget);
      const intake = await runIntakeStage(client, intakeModel, 'How do I open the return route?', '', flags,
        controls, undefined, undefined, budget, undefined, 'compact-v1');
      const reasoning = await runReasoningStage(client, intake.framedRequest, flags, controls, 'simple', { effort: 'none' }, budget);
      const final = await runFinalStage(client, '', 'How do I open the return route?', reasoning.output, flags,
        controls, reasoning.reasoningHonesty, undefined, undefined, budget);
      observation.stage = 'answer_audit';
      const evidenceAssessment = createGamingClearAssessment({ profile: 'evidence', questionProfile: 'walkthrough',
        subjectId: 'evidence-1', subjectHash: gamingClearHash(text), contextFingerprint: gamingClearContextFingerprint('context'),
        evidenceRefs: refs, dimensions: dimensions(), gates: { security: 'verified', identity: 'verified', compatibility: 'verified',
          freshness: 'not_applicable', provenance: 'verified', claimSupport: 'verified' } });
      const audit = await runGamingClearAnswerAudit(client, {
        game: 'Lantern Vale', mode: 'guide', prompt: 'How do I open the return route?', answer: final.output, evidenceAssessment,
        knowledge: { context: text, sources: [{ sourceId: refs[0], url: 'https://example.com/guide', sourceType: 'guide',
          game: 'Lantern Vale', fetchedAt: '2026-09-09T12:00:00.000Z', snippet: text }],
        evidence: [{ sourceId: refs[0], revisionId: refs[1], recordId: refs[2], publicUrl: 'https://example.com/guide',
          recordType: 'guide', text, lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: '2026-09-09T12:00:00.000Z' } }] }
      }, budget);
      provider.endWorkflow();
      expect(audit.assessment).toMatchObject({ profile: 'answer', assessmentStatus: 'completed', decision: 'accept' });
      expect(payloads.map(payload => [payload.model, payload.max_output_tokens])).toEqual([
        ['gpt-6-luna', 500], ['gpt-6.1-sol', LIVE_VALIDATION_TOKEN_LIMITS.maxOutputTokensPerRequest],
        [authority, 1000], ['gpt-6-luna', 1024]
      ]);
      expect(payloads.every(payload => payload.store === false && payload.max_output_tokens <= 4096)).toBe(true);
      expect(provider.snapshot()).toMatchObject({ closed: false,
        usage: { requests: 5, generationCalls: 3, auditCalls: 1, providerCalls: 4 } });
    } finally { provider.close(); }
  });
});
