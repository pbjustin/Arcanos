import type OpenAI from 'openai';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Agent as HttpsAgent, createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TrinityWritingPipelineRequest } from '../src/core/logic/trinityWritingPipeline.js';
import type { GamingPipelineRuntime } from '../src/services/gamingPipeline.js';
import { GAMING_CLEAR_APPROVED_ANSWER } from '../src/shared/gaming/gamingClearAnswerBinding.js';
import { gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';

const runTrinityWritingPipeline = jest.fn();
const createSingleChatCompletion = jest.fn();
const buildStoredGamingKnowledgeContext = jest.fn();
const defaultClient = {} as OpenAI;
const scopedClient = {} as OpenAI;
const getOpenAIClientOrAdapter = jest.fn(() => ({ client: defaultClient }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return ['2606:4700:4700::1111']; }
  cancel() { /* Disposable fixture resolution is immediate. */ }
} }));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({ runTrinityWritingPipeline }));
jest.unstable_mockModule('@services/openai/chatFallbacks.js', () => ({ createSingleChatCompletion }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({ getOpenAIClientOrAdapter }));
jest.unstable_mockModule('@services/openai/credentialProvider.js', () => ({
  getClearAuditModel: () => 'gpt-6-luna', getClearAuditEscalationModel: () => 'gpt-6.1-sol'
}));
jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({ buildStoredGamingKnowledgeContext }));
const { runGameplayPipeline } = await import('../src/services/gamingPipeline.js');
const { clearGamingRagCache } = await import('../src/services/gamingWebContext.js');

const ENV_KEYS = ['ARCANOS_ALLOW_LOCALHOST_FETCH', 'ARCANOS_GAMING_DISCOVERY_ENABLED',
  'ARCANOS_GAMING_RAG_ENABLED', 'ARCANOS_GAMING_RAG_MAX_CHUNKS', 'ARCANOS_GAMING_RAG_MAX_SOURCES',
  'ARCANOS_GAMING_WEB_CONTEXT_CHARS', 'ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS'] as const;
const previousEnv = new Map<string, string | undefined>();
const text = 'Lantern Vale Tide Hall walkthrough. After restoring the Tide Hall pump, turn the west valve beside the pump to open the return route.';
const answer = '**Open the return route.**\n\nTurn the west valve beside the pump. [Source 1]';
const input = { game: 'Lantern Vale', mode: 'guide' as const,
  prompt: 'How do I open the return route in Lantern Vale after restoring the Tide Hall pump?',
  guideUrls: [], auditEnabled: false, currentArea: 'Tide Hall', lastCompletedObjective: 'restored pump',
  spoilerMode: 'none' as const, answerDepth: 'concise' as const };
let server: Server;
let port: number;
let certificate: ReturnType<typeof createFixtureCertificate>;
const originalCreateConnection = HttpsAgent.prototype.createConnection;
let baseUrl = '';
let acquisitionRequests = 0;
let candidateAnswer = answer;
let tamper = false;
let auditEvents: string[] = [];
const onEvidenceAssessment = jest.fn<NonNullable<GamingPipelineRuntime['onEvidenceAssessment']>>();
const onAnswerAudit = jest.fn<NonNullable<GamingPipelineRuntime['onAnswerAudit']>>();
const runtime = (): GamingPipelineRuntime => ({ client: scopedClient, skipStoredRetrieval: true,
  onEvidenceAssessment, onAnswerAuditStart: () => auditEvents.push('audit-start'), onAnswerAudit });
const run = (path = '/guide', overrides = {}) => runGameplayPipeline(
  { ...input, guideUrl: baseUrl + path, ...overrides }, undefined, runtime());

// The protected transport suite uses the same disposable, in-memory certificate pattern.
// Keep real TLS hostname verification while redirecting only the physical test socket.
function createFixtureCertificate() {
  const der = (tag: number, ...values: Buffer[]): Buffer => {
    const body = Buffer.concat(values);
    const octets: number[] = [];
    for (let remaining = body.length; remaining > 0; remaining >>>= 8) octets.unshift(remaining & 255);
    const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([128 + octets.length, ...octets]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const sequence = (...values: Buffer[]) => der(0x30, ...values);
  const oid = (hex: string) => der(6, Buffer.from(hex, 'hex'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5));
  const subject = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Disposable Gaming Fixture')))));
  const tbs = sequence(der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, subject,
    sequence(der(0x17, Buffer.from('240101000000Z')), der(0x17, Buffer.from('490101000000Z'))),
    subject, pair.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      sequence(oid('551d13'), der(1, Buffer.from([255])), der(4, sequence(der(1, Buffer.from([255]))))),
      sequence(oid('551d11'), der(4, sequence(der(0x82, Buffer.from('fixture.example.com')))))
    )));
  const certificate = sequence(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, pair.privateKey)));
  return { key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n` };
}

describe('Gaming isolated transient runtime', () => {
  beforeAll(async () => {
    for (const key of ENV_KEYS) previousEnv.set(key, process.env[key]);
    process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = 'false';
    process.env.ARCANOS_GAMING_DISCOVERY_ENABLED = 'false';
    process.env.ARCANOS_GAMING_RAG_ENABLED = 'true';
    process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS = '6';
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '4';
    process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS = '5000';
    process.env.ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS = '2000';
    certificate = createFixtureCertificate();
    server = createServer(certificate, (request, response) => {
      acquisitionRequests += 1;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (request.url === '/unavailable') { response.statusCode = 503; response.end('Unavailable'); return; }
      const body = request.url === '/incompatible'
        ? 'Elden Ring beginner guide. Upgrade your weapon before entering Stormveil Castle and learn the boss attack windows.'
        : request.url === '/insufficient' ? 'Lantern Vale guide index. Sign in to read the guide.' : text;
      const title = request.url === '/incompatible' ? 'Elden Ring guide' : 'Lantern Vale guide';
      response.end(`<!doctype html><html><head><title>${title}</title></head><body><main><article><p>${body}</p></article></main></body></html>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    baseUrl = 'https://fixture.example.com';
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  beforeEach(() => {
    jest.clearAllMocks(); clearGamingRagCache(); acquisitionRequests = 0; candidateAnswer = answer; tamper = false; auditEvents = [];
    jest.spyOn(HttpsAgent.prototype, 'createConnection').mockImplementation(function (options, callback) {
      return originalCreateConnection.call(this, { ...options, host: '127.0.0.1', hostname: '127.0.0.1', port,
        ca: certificate.cert, lookup: () => { throw new Error('Unexpected unpinned hostname lookup'); }
      }, callback);
    });
    buildStoredGamingKnowledgeContext.mockImplementation(async () => ({ context: '', sources: [] }));
    createSingleChatCompletion.mockImplementation(async (_client, params: { messages: Array<{ content: string }> }) => {
      auditEvents.push('audit-transport');
      const data = JSON.parse(params.messages[1].content) as { evidence: Array<{ chunkId: string }> };
      const evidenceRefs = [data.evidence[0].chunkId];
      const dimensions = Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience']
        .map(name => [name, { status: 'evaluated', score: 4.5, reasonCodes: ['SUPPORTED'], evidenceRefs, unresolvedFacts: [] }]));
      return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ dimensions, findings: [] }) } }],
        usage: { prompt_tokens: 500, completion_tokens: 150, total_tokens: 650 } };
    });
    runTrinityWritingPipeline.mockImplementation(async (request: TrinityWritingPipelineRequest) => {
      const audit = await request.context.runOptions!.gamingClearAnswerAudit!(candidateAnswer, request.context.runtimeBudget!);
      return { result: tamper ? `${candidateAnswer}\nInvented mechanic.` : candidateAnswer, gamingClearAudit: audit.assessment,
        fallbackFlag: false, dryRun: false, activeModel: 'synthetic',
        meta: { provider: { finishReason: 'stop', responseStatus: 'completed' } } };
    });
  });

  it('keeps real document acquisition and mandatory audit while isolating SQL, client and memory', async () => {
    const result = await run();
    expect(acquisitionRequests).toBe(1);
    expect(result.data.response).toBe(answer);
    expect(result.data.grounding).toMatchObject({ groundingStatus: 'grounded', groundedInSuppliedEvidence: true });
    expect(result.data.fallbackReason).toBeUndefined();
    expect(buildStoredGamingKnowledgeContext).not.toHaveBeenCalled();
    expect(getOpenAIClientOrAdapter).not.toHaveBeenCalled();
    const request = runTrinityWritingPipeline.mock.calls[0][0] as TrinityWritingPipelineRequest;
    expect(request.context.client).toBe(scopedClient);
    expect(request.context.runOptions).toMatchObject({ disableMemoryAccess: true, disableOptionalSideEffects: true, redactAuditContent: true });
    expect(request.input.prompt).toContain('west valve');
    expect(createSingleChatCompletion.mock.calls[0][0]).toBe(scopedClient);
    expect(auditEvents).toEqual(['audit-start', 'audit-transport']);
    expect(onEvidenceAssessment).toHaveBeenCalledWith(expect.objectContaining({ profile: 'evidence', decision: 'accept' }));
    expect(onAnswerAudit).toHaveBeenCalledWith(expect.objectContaining({ assessment: expect.objectContaining({
      profile: 'answer', decision: 'accept', assessmentStatus: 'completed', subjectHash: gamingClearHash(answer)
    }), usage: { prompt_tokens: 500, completion_tokens: 150, total_tokens: 650 } }));
    expect(Object.getOwnPropertyDescriptor(result.data, GAMING_CLEAR_APPROVED_ANSWER)?.value)
      .toEqual(onAnswerAudit.mock.calls[0][0].assessment);
  });

  it('preserves default durable retrieval and default provider lookup without injected runtime', async () => {
    const result = await runGameplayPipeline({ ...input, guideUrl: baseUrl + '/guide' });
    expect(result.data.response).toBe(answer);
    expect(buildStoredGamingKnowledgeContext).toHaveBeenCalledTimes(1);
    expect(getOpenAIClientOrAdapter).toHaveBeenCalledTimes(1);
    const request = runTrinityWritingPipeline.mock.calls[0][0] as TrinityWritingPipelineRequest;
    expect(request.context.client).toBe(defaultClient);
    expect(request.context.runOptions?.disableMemoryAccess).toBeUndefined();
  });

  it.each(['/incompatible', '/insufficient', '/unavailable'])('rejects %s evidence before generation or answer audit', async path => {
    await expect(run(path)).rejects.toMatchObject({ name: 'GamingSourceEvidenceError' });
    expect(acquisitionRequests).toBe(1);
    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(buildStoredGamingKnowledgeContext).not.toHaveBeenCalled();
    expect(getOpenAIClientOrAdapter).not.toHaveBeenCalled();
    expect(onAnswerAudit).not.toHaveBeenCalled();
  });

  it('observes audit timeout without granting answer acceptance', async () => {
    createSingleChatCompletion.mockRejectedValue(Object.assign(new Error('synthetic audit timeout'), { name: 'AbortError' }));
    const result = await run();
    expect(result.data.fallbackReason).toBe('GAMING_ANSWER_AUDIT_UNAVAILABLE');
    expect(result.data.grounding?.groundedInSuppliedEvidence).toBe(false);
    expect(Object.getOwnPropertyDescriptor(result.data, GAMING_CLEAR_APPROVED_ANSWER)).toBeUndefined();
    expect(onAnswerAudit).toHaveBeenCalledWith(expect.objectContaining({ assessment: expect.objectContaining({
      assessmentStatus: 'unavailable', decision: 'unavailable', findings: expect.arrayContaining([expect.objectContaining({ code: 'AUDIT_TIMEOUT' })])
    }) }));
  });

  it('withholds acceptance after a post-audit answer mutation', async () => {
    tamper = true;
    const result = await run();
    expect(onAnswerAudit.mock.calls[0][0].assessment.decision).toBe('accept');
    expect(result.data.fallbackReason).toBe('GAMING_ANSWER_REJECTED');
    expect(result.data.response).not.toContain('Invented mechanic');
    expect(Object.getOwnPropertyDescriptor(result.data, GAMING_CLEAR_APPROVED_ANSWER)).toBeUndefined();
  });

  it('keeps observer snapshots separate from the source admission and final audit decisions', async () => {
    onEvidenceAssessment.mockImplementationOnce(assessment => { assessment.decision = 'reject'; });
    onAnswerAudit.mockImplementationOnce(result => { result.assessment.subjectHash = gamingClearHash('Different answer'); });
    const result = await run();
    expect(result.data.response).toBe(answer);
    expect(result.data.fallbackReason).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(result.data, GAMING_CLEAR_APPROVED_ANSWER)?.value.subjectHash)
      .toBe(gamingClearHash(answer));
  });

  it('keeps generation timeout separate from the answer audit', async () => {
    runTrinityWritingPipeline.mockRejectedValue(Object.assign(new Error('synthetic model timeout'), { name: 'AbortError', timeoutPhase: 'provider' }));
    const result = await run();
    expect(result.data.fallbackReason).toBe('INTAKE_UPSTREAM_TIMEOUT');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(onAnswerAudit).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([]);
  });
});
