import type OpenAI from 'openai';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Agent as HttpsAgent, createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TrinityWritingPipelineRequest } from '../src/core/logic/trinityWritingPipeline.js';
import type { GamingPipelineRuntime } from '../src/services/gamingPipeline.js';
import { GAMING_CLEAR_APPROVED_ANSWER } from '../src/shared/gaming/gamingClearAnswerBinding.js';
import { GAMING_PRESENTED_ANSWER, hasBoundGamingPresentedAnswer } from '../src/shared/gaming/gamingPresentedAnswerBinding.js';
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
const onEvidenceAssessment = jest.fn<NonNullable<GamingPipelineRuntime['onEvidenceAssessment']>>();
const onStage = jest.fn<NonNullable<GamingPipelineRuntime['onStage']>>();
const presentationPolicy = 'gaming-clear-presentation/v1' as const;
const runtime = (): GamingPipelineRuntime => ({ client: scopedClient, skipStoredRetrieval: true,
  onEvidenceAssessment, onStage });
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
    jest.clearAllMocks(); clearGamingRagCache(); acquisitionRequests = 0; candidateAnswer = answer;
    jest.spyOn(HttpsAgent.prototype, 'createConnection').mockImplementation(function (options, callback) {
      return originalCreateConnection.call(this, { ...options, host: '127.0.0.1', hostname: '127.0.0.1', port,
        ca: certificate.cert, lookup: () => { throw new Error('Unexpected unpinned hostname lookup'); }
      }, callback);
    });
    buildStoredGamingKnowledgeContext.mockImplementation(async () => ({ context: '', sources: [] }));
    createSingleChatCompletion.mockImplementation(() => { throw new Error('The retired Gaming answer audit was dispatched.'); });
    runTrinityWritingPipeline.mockImplementation((request: TrinityWritingPipelineRequest) => {
      request.context.runOptions?.onStage?.({ stage: 'final', phase: 'completed' });
      return { result: candidateAnswer, gamingPresentationPolicy: presentationPolicy,
        fallbackFlag: false, dryRun: false, activeModel: 'synthetic',
        meta: { provider: { finishReason: 'stop', responseStatus: 'completed' } } };
    });
  });

  it('keeps real document acquisition and binds presented output while isolating SQL, client and memory', async () => {
    const result = await run();
    expect(acquisitionRequests).toBe(1);
    expect(result.data.response).toBe(answer);
    expect(result.data.grounding).toMatchObject({ groundingStatus: 'grounded', groundedInSuppliedEvidence: true });
    expect(result.data.fallbackReason).toBeUndefined();
    expect(buildStoredGamingKnowledgeContext).not.toHaveBeenCalled();
    expect(getOpenAIClientOrAdapter).not.toHaveBeenCalled();
    const request = runTrinityWritingPipeline.mock.calls[0][0] as TrinityWritingPipelineRequest;
    expect(request.context.client).toBe(scopedClient);
    expect(request.context.runOptions).toMatchObject({ disableMemoryAccess: true, disableOptionalSideEffects: true,
      redactAuditContent: true, gamingPresentationPolicy: presentationPolicy });
    expect(request.input.prompt).toContain('west valve');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(onStage).toHaveBeenCalledWith(expect.objectContaining({ stage: 'final', phase: 'completed' }));
    expect(onEvidenceAssessment).toHaveBeenCalledWith(expect.objectContaining({ profile: 'evidence', decision: 'accept' }));
    const [evidence] = onEvidenceAssessment.mock.calls[0];
    expect(Object.getOwnPropertyDescriptor(result.data, GAMING_PRESENTED_ANSWER)).toMatchObject({
      enumerable: false, value: { policyVersion: presentationPolicy, subjectHash: gamingClearHash(answer),
        evidenceSubjectHash: evidence.subjectHash, contextFingerprint: evidence.contextFingerprint }
    });
    expect(Object.getOwnPropertyDescriptor(result.data, GAMING_CLEAR_APPROVED_ANSWER)).toBeUndefined();
    expect(JSON.stringify(result.data)).not.toContain(presentationPolicy);
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

  it.each(['/incompatible', '/insufficient', '/unavailable'])('rejects %s evidence before generation', async path => {
    await expect(run(path)).rejects.toMatchObject({ name: 'GamingSourceEvidenceError' });
    expect(acquisitionRequests).toBe(1);
    expect(runTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(buildStoredGamingKnowledgeContext).not.toHaveBeenCalled();
    expect(getOpenAIClientOrAdapter).not.toHaveBeenCalled();
  });

  it('withholds a completed answer that cites a source outside the selected evidence', async () => {
    candidateAnswer = answer.replace('[Source 1]', '[Source 9]');
    const result = await run();
    expect(result.data.fallbackReason).toBeDefined();
    expect(result.data.response).not.toContain(candidateAnswer);
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(false);
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
  });

  it('keeps observer snapshots separate from source admission and final presentation binding', async () => {
    onEvidenceAssessment.mockImplementationOnce(assessment => {
      assessment.decision = 'reject';
      assessment.subjectHash = gamingClearHash('Different evidence');
    });
    const result = await run();
    expect(result.data.response).toBe(answer);
    expect(result.data.fallbackReason).toBeUndefined();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(result.data, GAMING_PRESENTED_ANSWER)?.value.evidenceSubjectHash)
      .not.toBe(gamingClearHash('Different evidence'));
  });

  it('does not attest a provider timeout as completed presentation', async () => {
    runTrinityWritingPipeline.mockRejectedValue(Object.assign(new Error('synthetic model timeout'), { name: 'AbortError', timeoutPhase: 'provider' }));
    const result = await run();
    expect(result.data.fallbackReason).toBe('INTAKE_UPSTREAM_TIMEOUT');
    expect(createSingleChatCompletion).not.toHaveBeenCalled();
    expect(hasBoundGamingPresentedAnswer(result.data)).toBe(false);
    expect(onStage).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'final', phase: 'completed' }));
  });
});
