import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { createLivePrPreviewApplication, type LivePrPreviewDependencies,
  type LivePrPreviewObservation, type LivePrPreviewSession } from '../src/livePrPreviewApplication.js';
import { createLivePrPreviewGamingAdapter, LIVE_PR_PREVIEW_GAMING_PATH as LIVE_PR_PREVIEW_PATH,
  type LivePrPreviewGamingExecutor } from '../src/livePrPreviewGamingAdapter.js';
import type { GamingRagContext } from '../src/services/gamingWebContext.js';
import type { GamingSuccessEnvelope } from '../src/services/gamingModes.js';
import { createGamingTokenVerifier } from '../src/chatgpt/gamingAuth.js';
import { createGamingClearAssessment, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import { GAMING_CLEAR_APPROVED_ANSWER } from '../src/shared/gaming/gamingClearAnswerBinding.js';
import { verifyLivePreviewEvidence } from '../scripts/live-pr-preview-verifier.mjs';

const NOW = Date.now();
const sourceCommit = 'a'.repeat(40);
const bearer = 'arcanos-preview-' + 'b'.repeat(64);
const identity: LivePrPreviewSession = { mode: 'live-backend-v1', sourceCommit, approvedSourceCommit: sourceCommit,
  deploymentId: '11111111-1111-4111-8111-111111111111', environmentName: 'live-pr-42', prNumber: 42,
  expiresAtMs: NOW + 60_000, testBearer: bearer, maxRequests: 8, requestTimeoutMs: 30_000, moduleIds: ['gaming'] };
const expectedIdentity = { ...identity, moduleId: 'gaming' };
const body = (caseId = 'useful_grounded_guide') => ({ caseId, input: { mode: 'guide', game: 'Lantern Vale',
  prompt: 'How do I open the return route?', guideUrl: 'https://guides.example/route' } });
const answer = 'Turn the west valve to open the return route [1].';
const assessment = (profile: 'evidence' | 'answer') => createGamingClearAssessment({ profile,
  questionProfile: 'walkthrough', subjectId: profile + ':fixture', subjectHash: gamingClearHash(profile === 'answer' ? answer : 'evidence'),
  contextFingerprint: gamingClearHash('fixture-context'), evidenceRefs: ['chunk-1'],
  gates: { identity: 'verified', compatibility: 'verified', security: 'verified', provenance: 'verified',
    claimSupport: 'verified', freshness: 'not_applicable' },
  dimensions: Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name,
    { status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED'], evidenceRefs: ['chunk-1'], unresolvedFacts: [] }
  ])) as Parameters<typeof createGamingClearAssessment>[0]['dimensions'], findings: [] });
const retrieval = (overrides = {}) => ({ fetchedSuppliedSourceCount: 1, selectedChunkCount: 1,
  sources: [{ url: 'https://guides.example/route', snippet: 'Turn the west valve to open the return route.' }],
  ...overrides }) as GamingRagContext;
const result = (bound = true): GamingSuccessEnvelope => {
  const value: GamingSuccessEnvelope = { ok: true, route: 'gaming', mode: 'guide', data: {
    response: answer, sources: retrieval().sources, grounding: { groundingStatus: 'grounded', requestedSourceCount: 1,
      fetchedSourceCount: 1, fetchedSuppliedSourceCount: 1, usableSourceCount: 1, citableSourceCount: 1,
      selectedChunkCount: 1, suppliedEvidenceSourceCount: 1, groundedInSuppliedEvidence: true } } };
  if (bound) Object.defineProperty(value.data, GAMING_CLEAR_APPROVED_ANSWER, { value: assessment('answer') });
  return value;
};
let observation: LivePrPreviewObservation;
const execute = jest.fn<LivePrPreviewGamingExecutor>();
const usage = jest.fn<LivePrPreviewDependencies['usage']>();
const deps = (): LivePrPreviewDependencies => ({ adapters: [createLivePrPreviewGamingAdapter(execute)], usage, observation: () => observation, now: () => NOW });
const app = (session = identity, dependencies = deps()) => createLivePrPreviewApplication(session, dependencies);

describe('private live PR preview HTTP admission and evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    observation = { stage: 'answer_audit', generationCalls: 1, auditCalls: 1 };
    usage.mockImplementation(async () => ({ requests: 2, reservedInputTokens: 4_000, reservedOutputTokens: 2_000,
      reservedTotalTokens: 6_000, reservedSpendMicroUsd: 6_000, observedInputTokens: 500, observedOutputTokens: 150,
      observedSpendMicroUsd: 650, elapsedMs: 1_000, providerCalls: observation.generationCalls + observation.auditCalls,
      generationCalls: observation.generationCalls, auditCalls: observation.auditCalls,
      limits: { maxRequests: 8, maxInputTokensPerRequest: 4_000, maxOutputTokensPerRequest: 2_000,
        maxTotalTokens: 20_000, durationMs: 60_000, maxSpendMicroUsd: 20_000, maxConcurrency: 1, maxRetries: 0 } }));
    execute.mockImplementation(async (_input, hooks) => {
      hooks.onRetrieval?.(retrieval()); hooks.onEvidenceAssessment?.(assessment('evidence'));
      hooks.onAnswerAuditStart?.(); hooks.onAnswerAudit?.({ assessment: assessment('answer') });
      return result();
    });
  });

  it('accepts only completed acquired grounding with a bound mandatory audit and keeps evidence sanitized', async () => {
    const response = await request(app()).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(response.status).toBe(200);
    expect(verifyLivePreviewEvidence(response.body, expectedIdentity)).toMatchObject({ status: 'PASS', accepted: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(response.body)).not.toContain(bearer);
    expect(JSON.stringify(response.body)).not.toContain(answer);
    expect(response.body.verification).toEqual({ syntheticPreview: 'unverified', liveBackend: 'unverified', installedPluginOAuth: 'unverified' });
  });

  it.each([undefined, 'Bearer wrong-preview-token', 'Basic ' + bearer])('rejects test identity %s before execution or provider accounting', async token => {
    const call = request(app()).post(LIVE_PR_PREVIEW_PATH);
    if (token) call.set('authorization', token);
    const response = await call.send(body());
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ code: 'UNAUTHORIZED_TEST_IDENTITY' });
    expect(execute).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  });

  it.each([{ approvedSourceCommit: 'c'.repeat(40) }, { environmentName: 'production' },
    { deploymentId: 'wrong-deployment' }, { mode: 'synthetic-preview' }])('fails session identity closed: %o', overrides => {
    expect(() => app({ ...identity, ...overrides } as LivePrPreviewSession)).toThrow('LIVE_PREVIEW_SESSION_INVALID');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects expired sessions and an expiry between auth and request reservation without execution', async () => {
    const expired = await request(app({ ...identity, expiresAtMs: NOW })).post(LIVE_PR_PREVIEW_PATH)
      .set('authorization', 'Bearer ' + bearer).send(body());
    expect(expired.status).toBe(403);
    let reads = 0;
    const crossing = await request(app(identity, { ...deps(), now: () => ++reads === 1 ? NOW : identity.expiresAtMs }))
      .post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(crossing.status).toBe(403);
    expect(execute).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  });

  it('charges request budget and permits only one executing request', async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    execute.mockImplementation(async () => { entered(); await pending; return result(false); });
    const application = app({ ...identity, maxRequests: 1 });
    const first = request(application).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body()).then(value => value);
    await started;
    const concurrent = await request(application).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(concurrent.status).toBe(429);
    expect(execute).toHaveBeenCalledTimes(1);
    release(); await first;
    const exhausted = await request(application).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(exhausted.status).toBe(429);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps timed-out underlying execution charged until it actually drains', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    execute.mockImplementation(async () => { await pending; return result(false); });
    const application = app({ ...identity, requestTimeoutMs: 5 });
    const first = await request(application).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(first.body.stages.delivery).toBe('rejected');
    const second = await request(application).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(second.status).toBe(429);
    expect(execute).toHaveBeenCalledTimes(1);
    release(); await pending;
  });

  it.each([['incompatible_source', 'INCOMPATIBLE_SOURCE'], ['insufficient_evidence', 'INSUFFICIENT_EVIDENCE'],
    ['acquisition_failure', 'ACQUISITION_FAILURE']])('records actual %s boundaries without providers', async (caseId, failureCode) => {
    observation = { stage: 'generation', generationCalls: 0, auditCalls: 0 };
    execute.mockImplementation(async (_input, hooks) => {
      hooks.onRetrieval?.(retrieval({ fetchedSuppliedSourceCount: caseId === 'acquisition_failure' ? 0 : 1,
        selectedChunkCount: 0, sources: caseId === 'incompatible_source'
          ? [{ url: 'https://guides.example/route', error: 'Source did not match the requested game or version.' }] : [] }));
      throw Object.assign(new Error('synthetic source rejection'), { code: caseId === 'acquisition_failure' ? 'GAMING_SOURCE_UNAVAILABLE' : 'GAMING_SOURCE_UNREADABLE' });
    });
    const response = await request(app()).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body(caseId));
    expect(response.body.failureCode).toBe(failureCode);
    expect(verifyLivePreviewEvidence(response.body, expectedIdentity)).toMatchObject({ status: 'PASS', accepted: false });
  });

  it('does not infer a claimed incompatible-source outcome from the case label', async () => {
    const response = await request(app()).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body('incompatible_source'));
    expect(response.body.failureCode).toBeNull();
    expect(verifyLivePreviewEvidence(response.body, expectedIdentity).status).toBe('FAIL');
  });

  it('uses the shared admission, budget and audited evidence profile for another registered module', async () => {
    const researchExecute = jest.fn(async (_input: unknown, observer: Parameters<LivePrPreviewDependencies['adapters'][number]['execute']>[1]) => {
      observer.onSourceAcquisition('passed'); observer.onSourceValidation('passed'); observer.onAnswerAuditStart();
      return { result: result(false), accepted: true,
        audit: { assessmentStatus: 'completed' as const, decision: 'accept' as const, boundToFinalAnswer: true } };
    });
    const application = app({ ...identity, moduleIds: ['research'], maxRequests: 1 }, { ...deps(), adapters: [{
      moduleId: 'research', validateInput: value => ({ ok: true, input: value }), execute: researchExecute,
    }] });
    const response = await request(application).post('/__preview/live/research').set('authorization', 'Bearer ' + bearer)
      .send({ caseId: 'useful_grounded_guide', input: { topic: 'Return route' } });
    expect(verifyLivePreviewEvidence(response.body, { ...identity, moduleId: 'research' })).toMatchObject({ status: 'PASS' });
    expect(response.body.acceptanceProfile).toBe('grounded-audited-answer-v1');
    expect(researchExecute).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
    const exhausted = await request(application).post('/__preview/live/research').set('authorization', 'Bearer ' + bearer)
      .send({ caseId: 'useful_grounded_guide', input: { topic: 'Return route' } });
    expect(exhausted.status).toBe(429); expect(researchExecute).toHaveBeenCalledTimes(1);
  });

  it.each(['research', 'not_registered', 'gaming_other'])('rejects unapproved or unavailable module %s before execution', async moduleId => {
    const response = await request(app()).post('/__preview/live/' + moduleId).set('authorization', 'Bearer ' + bearer).send(body());
    expect(response.status).toBe(403); expect(execute).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled();
  });

  it('rejects cached acquisition and does not count a bound prior answer as a fresh live pipeline', async () => {
    execute.mockImplementation(async (_input, hooks) => {
      hooks.onRetrieval?.(retrieval({ cacheHit: true })); hooks.onEvidenceAssessment?.(assessment('evidence'));
      hooks.onAnswerAuditStart?.(); hooks.onAnswerAudit?.({ assessment: assessment('answer') });
      return result();
    });
    const response = await request(app()).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(response.body.stages.source_acquisition).toBe('failed');
    expect(response.body.stages.delivery).toBe('rejected');
    expect(verifyLivePreviewEvidence(response.body, expectedIdentity).status).toBe('FAIL');
  });

  it('never accepts JSON audit claims, generation alone, fallback or a post-audit mutation', async () => {
    for (const kind of ['no-binding', 'fallback', 'tampered']) {
      execute.mockImplementationOnce(async (_input, hooks) => {
        hooks.onRetrieval?.(retrieval()); hooks.onEvidenceAssessment?.(assessment('evidence'));
        hooks.onAnswerAuditStart?.(); hooks.onAnswerAudit?.({ assessment: assessment('answer') });
        const value = result(kind !== 'no-binding');
        if (kind === 'fallback') value.data.fallbackReason = 'GAMING_PROVIDER_ERROR';
        if (kind === 'tampered') value.data.response += ' Unsupported mechanic.';
        return value;
      });
      const response = await request(app()).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
      expect(verifyLivePreviewEvidence(response.body, expectedIdentity).status).toBe('FAIL');
      expect(response.body.stages.delivery).toBe('rejected');
    }
  });

  it('records unknown provider failure as failed generation instead of a passed stage', async () => {
    observation = { stage: 'generation', generationCalls: 1, auditCalls: 0 };
    execute.mockImplementation(async (_input, hooks) => {
      hooks.onRetrieval?.(retrieval()); hooks.onEvidenceAssessment?.(assessment('evidence'));
      throw new Error('synthetic provider error');
    });
    const response = await request(app()).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer).send(body());
    expect(response.body.stages.generation).toBe('failed');
    expect(response.body.stages.answer_audit).toBe('not_run');
    expect(response.body.stages.delivery).toBe('rejected');
  });

  it('uses settled trusted broker counters before classifying generation and audit timeouts or exhausted budget', async () => {
    const originalUsage = usage.getMockImplementation()!;
    for (const stage of ['generation', 'answer_audit', 'budget'] as const) {
      observation = { stage: 'generation', generationCalls: 0, auditCalls: 0 };
      execute.mockImplementationOnce(async (_input, hooks) => {
        hooks.onRetrieval?.(retrieval()); hooks.onEvidenceAssessment?.(assessment('evidence'));
        if (stage === 'answer_audit') hooks.onAnswerAuditStart?.();
        throw new Error('physical broker rejected transport');
      });
      usage.mockImplementationOnce(async () => {
        observation.generationCalls = stage === 'budget' ? 0 : 1;
        observation.auditCalls = stage === 'answer_audit' ? 1 : 0;
        if (stage === 'budget') observation.budgetExhausted = true;
        else observation.timeoutStage = stage;
        return originalUsage();
      });
      const response = await request(app()).post(LIVE_PR_PREVIEW_PATH).set('authorization', 'Bearer ' + bearer)
        .send(body(stage === 'budget' ? 'exhausted_budget' : stage === 'generation' ? 'model_timeout' : 'audit_timeout'));
      expect(response.body.failureCode).toBe(stage === 'budget' ? 'BUDGET_EXHAUSTED' : stage === 'generation' ? 'MODEL_TIMEOUT' : 'AUDIT_TIMEOUT');
      expect(response.body.stages.generation).toBe(stage === 'generation' ? 'timed_out' : stage === 'answer_audit' ? 'passed' : 'not_run');
      expect(response.body.stages.answer_audit).toBe(stage === 'answer_audit' ? 'timed_out' : 'not_run');
      expect(response.body.stages.delivery).toBe('rejected');
    }
  });

  it('production Gaming OAuth rejects preview credentials despite arbitrary accidental live flags', async () => {
    const keyResolver = jest.fn<NonNullable<Parameters<typeof createGamingTokenVerifier>[1]>['keyResolver']>();
    const verify = createGamingTokenVerifier({ status: 'ready', issuer: 'https://oauth.example.com',
      resource: 'https://backend.example.com/chatgpt/gaming/mcp', jwksUrl: 'https://oauth.example.com/jwks',
      metadataUrl: 'https://backend.example.com/.well-known/oauth-protected-resource/chatgpt/gaming/mcp',
      ownerSubject: 'owner', autoStoreApproved: false }, {
      keyResolver, readEnvironmentValue: () => 'true'
    });
    expect(await verify('Bearer ' + bearer)).toEqual({ ok: false, error: 'invalid_token', status: 401 });
    expect(keyResolver).not.toHaveBeenCalled();
  });

  it('has no live authentication or route in the production or sealed application import graphs', async () => {
    const root = path.resolve('src');
    const queued = ['app.ts', 'start-server.ts', 'nativePrPreviewApplication.ts', 'start-native-pr-preview.ts']
      .map(file => path.join(root, file));
    const visited = new Set<string>();
    const aliases = [['@core/lib/', 'lib/'], ['@core/', 'core/'], ['@platform/', 'platform/'],
      ['@services/', 'services/'], ['@shared/', 'shared/'], ['@transport/', 'transport/']] as const;
    while (queued.length) {
      const file = queued.pop()!;
      if (visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, 'utf8');
      expect(source).not.toContain(LIVE_PR_PREVIEW_PATH);
      expect(source).not.toContain('livePrPreviewApplication');
      expect(source).not.toContain('start-live-pr-preview');
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const add = (specifier: string) => {
        const alias = aliases.find(([prefix]) => specifier.startsWith(prefix));
        const resolved = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier)
          : alias ? path.resolve(root, alias[1], specifier.slice(alias[0].length)) : undefined;
        if (resolved?.endsWith('.js') && resolved.startsWith(root + path.sep)) queued.push(resolved.slice(0, -3) + '.ts');
      };
      const walk = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
          && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text);
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text);
        ts.forEachChild(node, walk);
      };
      walk(parsed);
    }
    expect(visited.size).toBeGreaterThan(100);
  });
});
