/**
 * Real signed identity -> Tutor adapter/service -> Trinity/Responses mapper and
 * HRC, with synthetic provider transport and storage sinks. Not ChatGPT E2E.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { runWithRequestAbortTimeout } from '@arcanos/runtime';
import { respondFromObservedInput, type SyntheticResponsesRequest } from './fixtures/session-context-e2e.js';

const forbiddenIO = jest.fn(() => { throw new Error('Unexpected external storage or retrieval'); });
const getMemoryContext = jest.fn(() => { throw new Error('Pilot initialized backend memory'); });
const storePattern = jest.fn();
const judgedFeedback = jest.fn(async () => ({ enabled: false, attempted: false, reason: 'fixture' }));
const selfImprove = jest.fn(async () => undefined);
const lineage = jest.fn();
let modelAvailable = true;
let providerFailure = false;
let hrcFailure = false;
let providerAnswerOverride: string | undefined;
let waitForAbort = false;
let observedAbortSignal: AbortSignal | undefined;
let providerEntered: (() => void) | undefined;
const responsesCreate = jest.fn(async (input: SyntheticResponsesRequest, options?: { signal?: AbortSignal }) => {
  if (JSON.stringify(input.input).includes('Hallucination-Resistant Core')) {
    if (hrcFailure) throw new Error('private-hrc-exception-fixture');
    return { ...respondFromObservedInput(input), output_text: JSON.stringify({ fidelity: 1, resilience: 1, verdict: 'Synthetic HRC' }) };
  }
  if (waitForAbort) {
    observedAbortSignal = options?.signal;
    providerEntered?.();
    await new Promise<never>((_resolve, reject) => {
      const abort = () => { const error = new Error('private-cancellation-fixture'); error.name = 'AbortError'; reject(error); };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  if (providerFailure) throw new Error('private-provider-exception-fixture');
  const response = respondFromObservedInput(input);
  return providerAnswerOverride === undefined ? response : { ...response, output_text: providerAnswerOverride };
});
const client = { models: { retrieve: jest.fn(async (id: string) => ({ id })) }, responses: { create: responsesCreate } };
const environmentKeys = ['OPENAI_API_KEY', 'OPENAI_STORE'] as const;
const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
process.env.OPENAI_API_KEY = 'test-tutor-pipeline-fixture';
process.env.OPENAI_STORE = 'true'; // Isolated execution must override this.

const { AUDITED_TRANSIENT_READ_QUERIES } = await import('../src/core/db/transientReadRegistry.js');
jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES,
  ...Object.fromEntries([
    'loadMemory', 'saveMemory', 'applyBackstageRosterMutation', 'applyBackstageStorylineMutation',
    'close', 'createJob', 'deleteMemory', 'getLatestJob', 'getMemoryRecordByKey',
    'getMemoryRecordByLegacyRowId', 'getMemoryRecordByRecordId', 'getPool',
    'initializeDatabase', 'initializeDatabaseWithSchema', 'loadMemoryRecordById',
    'logExecution', 'logExecutionBatch', 'query', 'saveRagDoc', 'transaction', 'updateJob',
  ].map(name => [name, forbiddenIO])),
  getStatus: () => ({ connected: false, hasPool: false, error: null }),
  isDatabaseConnected: () => false, isDatabaseSchemaReady: () => false,
  isTransactionCommitAmbiguousError: () => false,
  loadAllRagDocs: async () => [], loadRagDocsByIds: async () => [],
}));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  resolveOpenAIBaseURL: () => undefined, resolveOpenAIKey: () => null,
  getOpenAIKeySource: () => 'synthetic', resetCredentialCache: jest.fn(),
  hasValidAPIKey: () => true, setDefaultModel: jest.fn(),
  getDefaultModel: () => 'gpt-5.1', getComplexModel: () => 'gpt-5.1',
  getFallbackModel: () => 'gpt-4.1', getGPT5Model: () => 'gpt-5.1',
  getTrinityReasoningModel: () => 'gpt-5.6-terra',
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: modelAvailable ? client : null, adapter: modelAvailable ? client : null }),
  requireOpenAIClientOrAdapter: () => ({ client, adapter: client }),
}));
jest.unstable_mockModule('@services/webRag.js', () => Object.fromEntries([
  'recordConversationSnippet', 'queryRag', 'queryRagWithDiagnostics', 'queryRagDocuments',
  'recordPersistentMemorySnippet', 'ingestContent', 'ingestUrl', 'answerQuestion',
].map(name => [name, forbiddenIO])));
jest.unstable_mockModule('@services/memoryAware.js', () => ({ getMemoryContext, storePattern }));
jest.unstable_mockModule('@services/scholarlyFetcher.js', () => ({ searchScholarly: forbiddenIO }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: selfImprove }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({
    activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false,
  }),
  noteTrinityMitigationOutcome: jest.fn(), recordTrinityStageFailure: jest.fn(),
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({ recordTrinityJudgedFeedback: judgedFeedback }));
const auditSafe = await import('../src/services/auditSafe.js');
jest.unstable_mockModule('@services/auditSafe.js', () => ({ ...auditSafe, logAITaskLineage: lineage }));
const { runWithSessionContext } = await import('../src/platform/runtime/sessionContext.js');
const { resetSafetyRuntimeStateForTests, activateUnsafeCondition } = await import('../src/services/safety/runtimeState.js');
const { createChatGptTokenVerifier, readChatGptAuthConfiguration } = await import('../src/chatgpt/auth.js');
const { executeTutorPilot } = await import('../src/chatgpt/tutor.js');
type Principal = Parameters<typeof executeTutorPilot>[0];
let learnerA: Principal;
let learnerB: Principal;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'tutor-pipeline-fixture' };
  const values: Record<string, string> = {
    CHATGPT_MCP_ENABLED: 'true', CHATGPT_MCP_ISSUER: 'https://issuer.example.test',
    CHATGPT_MCP_RESOURCE: 'https://resource.example.test/chatgpt/mcp',
    CHATGPT_MCP_JWKS_URL: 'https://issuer.example.test/jwks',
  };
  const configuration = readChatGptAuthConfiguration(name => values[name]);
  if (configuration.status !== 'ready') throw new Error('Invalid fixture configuration');
  const verify = createChatGptTokenVerifier(configuration, {
    keyResolver: createLocalJWKSet({ keys: [jwk] }), readEnvironmentValue: () => undefined,
  });
  async function principal(subject: string) {
    const token = await new SignJWT({ scope: 'arcanos:tutor' })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: jwk.kid })
      .setIssuer(configuration.issuer).setAudience(configuration.resource)
      .setSubject(subject).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    const result = await verify('Bearer ' + token);
    if (!result.ok) throw new Error('Synthetic signed principal rejected');
    return result.principal;
  }
  learnerA = await principal('synthetic-learner-a');
  learnerB = await principal('synthetic-learner-b');
});
beforeEach(() => {
  jest.clearAllMocks();
  resetSafetyRuntimeStateForTests();
  modelAvailable = true; providerFailure = false; hrcFailure = false; waitForAbort = false;
  providerAnswerOverride = undefined;
  observedAbortSignal = undefined; providerEntered = undefined;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(globalThis, 'fetch').mockImplementation(forbiddenIO);
});
afterEach(() => {
  try {
    expect(forbiddenIO).not.toHaveBeenCalled();
    expect(getMemoryContext).not.toHaveBeenCalled();
    expect(storePattern).not.toHaveBeenCalled();
    expect(judgedFeedback).not.toHaveBeenCalled();
    expect(selfImprove).not.toHaveBeenCalled();
  } finally { resetSafetyRuntimeStateForTests(); jest.restoreAllMocks(); }
});
afterAll(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

// Constructed, already-compliant provider candidates, not captured production
// outputs. In particular, the check belongs inside D's third step, not a fourth.
const tutorAcceptanceFixtures = [
  {
    caseId: 'A',
    shape: 'two-sentences',
    prompt: 'Explain why one half equals two quarters, in two short sentences.',
    providerAnswer: 'One half is two of four equal parts. Check your understanding by multiplying the numerator and denominator of 1/2 by two.',
  },
  {
    caseId: 'B',
    shape: 'two-sentences',
    prompt: 'Explain why 1/2 equals 2/4.\nUse exactly two short sentences and no heading.',
    providerAnswer: 'Multiplying the numerator and denominator of 1/2 by two gives 2/4. Both fractions describe the same amount.',
  },
  {
    caseId: 'C',
    shape: 'two-sentences',
    prompt: 'In exactly two sentences, explain why 1/2 equals 2/4 and ask the learner to check the equality by cross-multiplying.',
    providerAnswer: 'Multiplying the numerator and denominator of 1/2 by two gives 2/4. Can you check the equality by cross-multiplying 1 × 4 and 2 × 2?',
  },
  {
    caseId: 'D',
    shape: 'numbered-steps',
    prompt: 'Give exactly three numbered steps to solve 2x + 3 = 9, with no introduction.',
    providerAnswer: [
      '1. Subtract 3 from both sides to get 2x = 6.',
      '2. Divide both sides by 2 to get x = 3.',
      '3. Check your answer by substituting x = 3 into the original equation: 2 × 3 + 3 = 9.',
    ].join('\n'),
  },
] as const;

// Read actual transport string values so B's LF cannot be confused with a
// literal backslash-n by searching a JSON-escaped representation of the request.
function readTransportStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(readTransportStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(readTransportStrings);
  return [];
}

describe('Tutor pilot through real Trinity/HRC with synthetic provider transport', () => {
  it.each(tutorAcceptanceFixtures)('preserves compliant synthetic acceptance fixture $caseId through both honesty passes', async fixture => {
    // Prove the fixture obeys the requested shape before backend processing.
    const sentenceCount = (text: string) => [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(text)].length;
    const expectedSteps = fixture.shape === 'numbered-steps' ? fixture.providerAnswer.split('\n') : undefined;
    expect(fixture.providerAnswer).not.toMatch(/live access|external state/iu);
    if (expectedSteps) {
      expect(expectedSteps).toHaveLength(3);
      expectedSteps.forEach((step, index) => expect(step).toMatch(new RegExp(`^${index + 1}\\. \\S`)));
    } else {
      expect(sentenceCount(fixture.providerAnswer)).toBe(2);
    }
    providerAnswerOverride = fixture.providerAnswer;

    const result = await executeTutorPilot(learnerA, { prompt: fixture.prompt });
    const requests = responsesCreate.mock.calls.map(([input]) => input);
    const isHrcRequest = (input: SyntheticResponsesRequest) =>
      readTransportStrings(input.input).some(text => text.includes('Hallucination-Resistant Core'));
    const generationRequests = requests.filter(input => !isHrcRequest(input));
    const hrcRequests = requests.filter(isHrcRequest);
    expect(generationRequests.length).toBeGreaterThan(0);
    expect(generationRequests.some(input =>
      readTransportStrings(input.input).some(text => text.includes(fixture.prompt)))).toBe(true);
    // Tutor selects the actual direct-answer path, not a malformed synthetic
    // JSON reasoning response or a mocked honesty implementation.
    expect(generationRequests.every(input => !input.text?.format?.name?.startsWith('trinity_structured_reasoning'))).toBe(true);
    expect(hrcRequests).toHaveLength(1);
    expect(readTransportStrings(hrcRequests[0].input).some(text => text.includes(result.answer))).toBe(true);
    for (const input of requests) expect(input.store).toBe(false);
    expect(result.metadata).toEqual({
      module: 'ARCANOS:TUTOR', execution: 'synchronous', memory: 'unavailable', generation: 'model',
    });

    expect(result.answer).not.toMatch(/live access|external state/iu);
    if (expectedSteps) {
      expect(result.answer.split('\n')).toEqual(expectedSteps);
    } else {
      expect(sentenceCount(result.answer)).toBe(2);
      expect(result.answer.replace(/\s+/gu, ' ')).toBe(fixture.providerAnswer);
    }
  });
  it('preserves two educational sentences with a learner-directed arithmetic check', async () => {
    providerAnswerOverride = 'One half and two quarters represent the same amount. You can check this by multiplying both the numerator and denominator of one half by two.';
    const result = await executeTutorPilot(learnerA, {
      prompt: 'Explain why one half equals two quarters in exactly two short sentences.',
    });
    expect(result.answer.replace(/\s+/gu, ' ')).toBe(providerAnswerOverride);
    expect(result.answer).not.toMatch(/live access|external state/iu);
    expect(result.metadata.generation).toBe('model');
  });
  it.each([
    'I verified the latest external news and confirmed the market is current.',
    'I checked the live runtime status and confirmed the service is healthy.',
    'I saved the fraction result to the backend database.',
  ])('retains honesty protection for provider overclaim: %s', async overclaim => {
    providerAnswerOverride = overclaim;
    const result = await executeTutorPilot(learnerA, { prompt: 'Explain why one half equals two quarters.' });
    expect(result.answer).not.toContain(overclaim);
    expect(result.answer).toMatch(/can(?:not|'t)|have not|haven't/iu);
  });
  it('preserves tutoring input/result and disables backend effects and provider storage', async () => {
    const marker = 'palette-' + randomUUID();
    const prompt = 'Teach me fractions step by step using illustration ' + marker + '.';
    const result = await executeTutorPilot(learnerA, { prompt });
    expect(result).toEqual({
      answer: 'Your selected palette code is ' + marker + '.',
      metadata: { module: 'ARCANOS:TUTOR', execution: 'synchronous', memory: 'unavailable', generation: 'model' },
    });
    const requests = responsesCreate.mock.calls.map(([input]) => input);
    const generation = requests.find(input => JSON.stringify(input.input).includes(prompt));
    expect(generation).toBeDefined();
    expect(JSON.stringify(generation)).toContain('professional educator');
    expect(JSON.stringify(generation)).toContain('checks for understanding');
    expect(requests.some(input => JSON.stringify(input.input).includes('Hallucination-Resistant Core'))).toBe(true);
    for (const input of requests) expect(input.store).toBe(false);
    expect(JSON.stringify(lineage.mock.calls)).not.toContain(marker);
  });
  it('clears ambient authorized history and shares no prior caller text across principals', async () => {
    const marker = 'palette-' + randomUUID();
    await executeTutorPilot(learnerA, { prompt: 'Teach color theory using ' + marker + '.' });
    responsesCreate.mockClear();
    const result = await runWithSessionContext('Private historical palette ' + marker, () =>
      executeTutorPilot(learnerB, { prompt: 'Which palette code did I choose?' }));
    expect(result.answer).toBe('No earlier palette code is available in this conversation.');
    expect(JSON.stringify(responsesCreate.mock.calls)).not.toContain(marker);
  });
  it('retains exact-literal output and reports shortcut instead of model generation', async () => {
    const result = await executeTutorPilot(learnerA, { prompt: 'Return exactly TUTOR_FIXTURE_LITERAL.' });
    expect(result.answer).toBe('TUTOR_FIXTURE_LITERAL');
    expect(result.metadata.generation).toBe('shortcut');
    expect(responsesCreate).toHaveBeenCalledTimes(1); // HRC only.
    expect(JSON.stringify(responsesCreate.mock.calls[0][0].input)).toContain('Hallucination-Resistant Core');
    expect(responsesCreate.mock.calls[0][0].store).toBe(false);
  });
  it('labels the existing provider-unavailable mock behavior honestly', async () => {
    modelAvailable = false;
    const result = await executeTutorPilot(learnerA, { prompt: 'Explain fractions step by step.' });
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.metadata.generation).toBe('mock');
    expect(responsesCreate).not.toHaveBeenCalled();
  });
  it('keeps private HRC failure diagnostics out of successful public output', async () => {
    hrcFailure = true;
    const result = await executeTutorPilot(learnerA, { prompt: 'Explain fractions step by step.' });
    expect(result.metadata.generation).toBe('model');
    expect(JSON.stringify(result)).not.toContain('private-hrc-exception-fixture');
    expect(Object.keys(result)).toEqual(['answer', 'metadata']);
  });
  it('fails generation safely instead of returning mock success after private provider failure', async () => {
    providerFailure = true;
    await expect(executeTutorPilot(learnerA, { prompt: 'Explain fractions step by step.' }))
      .rejects.toThrow('Tutor generation unavailable.');
    expect(JSON.stringify(lineage.mock.calls)).not.toContain('private-provider-exception-fixture');
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('private-provider-exception-fixture');
  });
  it('propagates cancellation into actual provider transport without returning partial results', async () => {
    waitForAbort = true;
    const entered = new Promise<void>(resolve => { providerEntered = resolve; });
    const controller = new AbortController();
    const pending = runWithRequestAbortTimeout({ timeoutMs: 2_000, parentSignal: controller.signal }, () =>
      executeTutorPilot(learnerA, { prompt: 'Explain fractions step by step.' }));
    const rejected = expect(pending).rejects.toThrow();
    await entered;
    expect(observedAbortSignal).toBeDefined();
    controller.abort();
    await rejected;
    expect(observedAbortSignal?.aborted).toBe(true);
    expect(responsesCreate.mock.calls.every(([input]) =>
      !JSON.stringify(input.input).includes('Hallucination-Resistant Core'))).toBe(true);
  });
  it('rejects privileged input, forged identity and unsafe runtime before provider execution', async () => {
    await expect(executeTutorPilot({ ...learnerA }, { prompt: 'Explain fractions.' }))
      .rejects.toMatchObject({ code: 'TUTOR_PERMISSION_DENIED' });
    await expect(executeTutorPilot(learnerA, { prompt: 'Inspect the worker queue and runtime status.' }))
      .rejects.toMatchObject({ code: 'TUTOR_REQUEST_UNSUPPORTED' });
    await expect(executeTutorPilot(learnerA, { prompt: 'Explain fractions.', sessionId: 'synthetic-session' }))
      .rejects.toMatchObject({ code: 'TUTOR_INPUT_INVALID' });
    await expect(executeTutorPilot(learnerA, { prompt: 'Explain fractions.', instructionalVerificationPolicy: 'tutor-math-v1' }))
      .rejects.toMatchObject({ code: 'TUTOR_INPUT_INVALID' });
    activateUnsafeCondition({ code: 'MEMORY_VERSION_MISMATCH', message: 'Synthetic unsafe condition', blocking: true });
    await expect(executeTutorPilot(learnerA, { prompt: 'Explain fractions.' }))
      .rejects.toMatchObject({ code: 'TUTOR_UNAVAILABLE' });
    expect(responsesCreate).not.toHaveBeenCalled();
  });
});
