import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

// Held-out, authored SYNTHETIC material. These fixtures make no claim that the
// fabricated publisher pages exist or that model/gameplay quality was measured.
// OAuth, MCP schemas, discovery/ranking, protected acquisition, extraction,
// source/evidence admission, Trinity orchestration and final answer binding are real.
// External search/HTTPS/DNS/SDK, empty durable lookup and ingress admission are
// controlled seams. No application service, provider or production data is used.
const publisher = jest.fn();
const sdk = jest.fn();
const modelLookup = jest.fn(async (id: string) => ({ id }));
const write = jest.fn(async () => { throw new Error('Held-out acceptance forbids persistence.'); });
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(publisher) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: { responses: { create: sdk }, models: { retrieve: modelLookup } } })
}));
jest.unstable_mockModule('@services/memoryAware.js', () => ({
  getMemoryContext: () => ({ relevantEntries: [], contextSummary: '', accessLog: [] }), storePattern: write
}));
jest.unstable_mockModule('../src/core/logic/trinityJudgedFeedback.js', () => ({ recordTrinityJudgedFeedback: write }));
jest.unstable_mockModule('@services/selfImprove/controller.js', () => ({ runSelfImproveCycle: write }));
jest.unstable_mockModule('@services/selfImprove/selfHealingV2.js', () => ({
  getTrinitySelfHealingMitigation: () => ({ activeAction: null, stage: null, bypassFinalStage: false, forceDirectAnswer: false, verified: false }),
  noteTrinityMitigationOutcome: jest.fn(), recordTrinityStageFailure: jest.fn()
}));

const { createGamingHybridWorkflow } = await import('../src/services/gamingHybridKnowledge.js');
const { evaluateGamingHybridCandidates } = await import('../src/services/gamingHybridCandidates.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { discoverGamingSources, createBraveGamingSearchProvider, clearGamingDiscoveryCache } = await import('../src/services/gamingSourceDiscovery.js');
const { createGamingMcpExecutor } = await import('../src/chatgpt/gaming.js');
const { createChatGptGamingMcpRouter } = await import('../src/routes/chatgptGamingMcp.js');
const { readGamingAuthConfiguration } = await import('../src/chatgpt/gamingAuth.js');
const { GAMING_MCP_PATH, GAMING_QUERY_SCOPE, isGamingMcpOutput } = await import('../src/shared/chatgpt/gamingMcpContract.js');
const { logger, aiLogger } = await import('../src/platform/logging/structuredLogging.js');
const { resetSafetyRuntimeStateForTests } = await import('../src/services/safety/runtimeState.js');

interface Claim {
  url: string;
  draft: string;
  answerProbe: RegExp;
  support: RegExp[];
}
interface Scenario {
  id: string;
  game: string;
  question: string;
  pages: Array<{ url: string; title: string; body: string }>;
  claims: Claim[];
  advisory?: boolean;
}
const scenarios: Scenario[] = [
  { id: 'A', game: 'The Legend of Zelda: Ocarina of Time', question: 'Where do I get the Deku Shield early in Ocarina of Time?',
    pages: [{ url: 'https://heldout-guides.example/oot/deku-shield-shop', title: 'Ocarina of Time early Deku Shield shop guide',
      body: '<h2>Early equipment</h2><p>In the game The Legend of Zelda: Ocarina of Time, the Kokiri Shop in Kokiri Forest sells the Deku Shield for 40 Rupees. Child Link can buy and equip the Deku Shield before entering the first dungeon. Collect Rupees around Kokiri Forest, then enter the Kokiri Shop to purchase the shield.</p>' }],
    claims: [{ url: 'https://heldout-guides.example/oot/deku-shield-shop',
      draft: 'Child Link can buy the Deku Shield at Kokiri Shop in Kokiri Forest for 40 Rupees early on.',
      answerProbe: /Deku Shield.*Kokiri Shop.*Kokiri Forest.*40 Rupees/iu,
      support: [/Kokiri Shop/iu, /Kokiri Forest/iu, /40 Rupees/iu, /Child Link/iu] }] },
  { id: 'B', game: 'Elden Ring', question: 'Find a good early-game Samurai build guide. No major spoilers.', advisory: true,
    pages: [{ url: 'https://heldout-guides.example/elden-ring/starting-samurai', title: 'Elden Ring early-game Samurai build guide',
      body: '<p>In the game Elden Ring, an early-game Samurai build uses the starting Uchigatana and Unsheathe skill with base-game equipment. Prioritize Vigor for survival, then meet Dexterity requirements. Raise Endurance enough to retain a medium equipment load rather than heavy rolling.</p><h2>Starting katana upgrades and combat</h2><p>Upgrade the Uchigatana with Smithing Stones at the Church of Elleh smithing table before seeking new weapons. Use a light attack to test an opening, use Unsheathe only after an enemy attack misses, then dodge and recover stamina. These starting Samurai recommendations require no expansion. They use no later-story rewards.</p>' }],
    claims: [{ url: 'https://heldout-guides.example/elden-ring/starting-samurai',
      draft: 'For a spoiler-light base-game Samurai start, retain the Uchigatana and Unsheathe, prioritize Vigor, meet Dexterity requirements, and keep a medium equipment load.',
      answerProbe: /Uchigatana.*Unsheathe.*Vigor.*Dexterity.*medium/iu,
      support: [/Uchigatana/iu, /Unsheathe/iu, /Vigor/iu, /Dexterity/iu, /medium/iu] }] },
  { id: 'C', game: 'Elite Dangerous', question: 'Find a detailed guide explaining system colonisation and how to get started.',
    pages: [{ url: 'https://heldout-guides.example/elite/colonisation-first-system', title: 'Elite Dangerous system colonisation getting started guide',
      body: '<p>In the game Elite Dangerous, system colonisation starts by selecting an uninhabited candidate system and purchasing a colonisation claim from a colonisation contact. Travel to the selected system with the claim, deploy the system colonisation ship, and deliver the construction commodities requested by the project. Complete the requested deliveries before the project deadline. Establish a colony in Elite Dangerous’ outer systems.</p><p>This authored walkthrough reports the PC Live 4.0 release and patch 19.02. It does not establish availability on console or Legacy releases, and it does not verify which patch is active today. Check the project requirements before committing the claim because commodity quantities depend on the selected project.</p>' }],
    claims: [{ url: 'https://heldout-guides.example/elite/colonisation-first-system',
      draft: 'The guide starts system colonisation by selecting an uninhabited system and buying a colonisation claim, then deploying the colonisation ship and delivering the requested construction commodities before the deadline.',
      answerProbe: /uninhabited system.*colonisation claim.*colonisation ship.*construction commodities.*deadline/iu,
      support: [/uninhabited/iu, /colonisation claim/iu, /colonisation ship/iu, /construction commodities/iu, /deadline/iu] },
    { url: 'https://heldout-guides.example/elite/colonisation-first-system',
      draft: 'The selected excerpts do not establish platform or edition compatibility, or which patch is active.',
      answerProbe: /do not establish platform.*edition.*patch/iu, support: [] }] },
  { id: 'D', game: 'Xenoblade Chronicles 2', question: 'Find a Chapter 2 guide for Rex as DPS and Nia as healer. Avoid later-story spoilers.', advisory: true,
    pages: [{ url: 'https://heldout-guides.example/xc2/chapter-two-rex', title: 'Xenoblade Chronicles 2 Chapter 2 Rex DPS guide',
      body: '<p>In the game Xenoblade Chronicles 2, this Chapter 2 guide uses Rex as DPS. Rex should keep his starting attacker Blade, maintain auto-attacks long enough to recharge Arts, and cancel an auto-attack into an Art when the timing ring appears. Position Rex to use the damage bonus stated on the equipped Art. This Chapter 2 Rex DPS advice uses only the party equipment available at this checkpoint.</p>' },
    { url: 'https://heldout-community.example/xc2/chapter-two-nia', title: 'Xenoblade Chronicles 2 Chapter 2 Nia healer guide',
      body: '<p>In the game Xenoblade Chronicles 2, the Chapter 2 party can use Nia as healer. Keep Dromarch equipped on Nia for healing, prioritize accessories that improve her healing role, and let Nia recharge healing Arts with auto-attacks. Collect dropped healing potions when party health is low. This Chapter 2 guide contains no later-story rewards or character revelations.</p>' }],
    claims: [{ url: 'https://heldout-guides.example/xc2/chapter-two-rex',
      draft: 'In Chapter 2, use Rex as DPS with his starting attacker Blade; recharge Arts through auto-attacks and cancel into an Art at its timing ring.',
      answerProbe: /Chapter 2.*Rex as DPS.*auto-attacks.*Art/iu,
      support: [/Chapter 2/iu, /Rex as DPS/iu, /auto-attacks/iu, /timing ring/iu] },
    { url: 'https://heldout-community.example/xc2/chapter-two-nia',
      draft: 'For Nia as healer, keep Dromarch equipped, support her healing role with accessories, and collect healing potions when health is low.',
      answerProbe: /Nia as healer.*Dromarch.*accessories.*healing potions/iu,
      support: [/Nia as healer/iu, /Dromarch/iu, /accessories/iu, /healing potions/iu] }] },
  { id: 'E', game: 'Aetherglass Requiem', question: 'How do I restart the rainwheel at the Glass Orchard?',
    pages: [{ url: 'https://heldout-community.example/aetherglass/rainwheel', title: 'Aetherglass Requiem Glass Orchard rainwheel guide',
      body: '<p>Aetherglass Requiem is an exploration game. In the game Aetherglass Requiem, restart the rainwheel at the Glass Orchard by closing the east sluice, inserting the copper spindle, and turning the wheel three times. The rainwheel restarts only when the east sluice is closed and the copper spindle is inserted. Wait for the blue water indicator before reopening the sluice.</p>' }],
    claims: [{ url: 'https://heldout-community.example/aetherglass/rainwheel',
      draft: 'At the Glass Orchard, close the east sluice, insert the copper spindle, and turn the rainwheel three times; wait for the blue water indicator before reopening the sluice.',
      answerProbe: /Glass Orchard.*east sluice.*copper spindle.*three times.*blue water indicator/iu,
      support: [/Glass Orchard/iu, /east sluice/iu, /copper spindle/iu, /three times/iu, /blue water indicator/iu] }] }
];

let scenario = scenarios[0];
let adversarialFinal: 'none' | 'unsupported_quantity' | 'wrong_citation_url' = 'none';
let sourceSuffix = '';
let searchUnavailable = false;
const stages: string[] = [];
const searches: string[] = [];
const acquired: string[] = [];
let finalText = '';
let finalInput = '';
let finalEvidence: Array<{ sourceIndex: number; url: string; text: string }> = [];
const documents: Awaited<ReturnType<typeof resolveGamingDocument>>[] = [];
const evaluations: Awaited<ReturnType<typeof evaluateGamingHybridCandidates>>[] = [];
const environment = { FINETUNED_MODEL_ID: 'ft:gpt-4.1:synthetic:heldout-gaming',
  ARCANOS_GAMING_RAG_ENABLED: 'false', ARCANOS_GAMING_DISCOVERY_ENABLED: 'true',
  ARCANOS_GAMING_HYBRID_BACKEND_DISCOVERY_ENABLED: 'false', BRAVE_SEARCH_API_KEY: 'heldout-synthetic-search-only',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]', ARCANOS_GAMING_WEB_CONTEXT_CHARS: '18000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '2000' };
let saved: Record<string, string | undefined>;
const auth = { CHATGPT_GAMING_ENABLED: 'true', CHATGPT_GAMING_ISSUER: 'https://heldout-issuer.invalid/',
  CHATGPT_GAMING_RESOURCE: 'https://heldout-resource.invalid/chatgpt/gaming/mcp',
  CHATGPT_GAMING_JWKS_URL: 'https://heldout-issuer.invalid/jwks', CHATGPT_GAMING_OWNER_SUBJECT: 'heldout-owner' };
const configuration = readGamingAuthConfiguration(name => auth[name as keyof typeof auth]);
if (configuration.status !== 'ready') throw new Error('Held-out OAuth fixture is unavailable.');
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'heldout-gaming', alg: 'RS256' }] });
});
const messageText = (payload: any): string => typeof payload.input === 'string' ? payload.input : payload.input.map((message: any) => typeof message.content === 'string'
  ? message.content : message.content.map((part: any) => part.text ?? '').join('')).join('\n');
function draft(payload: any, final = false): string {
  const text = messageText(payload);
  const numbered = [...text.matchAll(/\[Source (\d+)\][\s\S]*?URL: (https:\/\/[^\s"\\]+)/gu)];
  const numberFor = (url: string) => Number(numbered.find(match => match[2].trim() === url)?.[1]);
  const response = scenario.claims.map((claim, index) => {
    expect(claim.support.filter(probe => !probe.test(text)).map(probe => probe.source)).toEqual([]);
    const source = numberFor(claim.url);
    expect(source).toBeGreaterThan(0);
    if (final && adversarialFinal === 'wrong_citation_url' && index === 0)
      return claim.draft + ' [' + source + '](' + scenario.pages[1].url + ')';
    return claim.draft + ' [' + source + ']';
  }).join('\n\n');
  // Exercise the declared boundary: the backend verifies citation structure;
  // a syntactically valid citation is not an independent factual verdict.
  return final && adversarialFinal === 'unsupported_quantity' ? response + '\n\nThe Deku Shield costs 9999 Rupees. [1]' : response;
}
beforeEach(() => {
  jest.clearAllMocks(); resetSafetyRuntimeStateForTests(); clearGamingDiscoveryCache();
  scenario = scenarios[0]; adversarialFinal = 'none'; sourceSuffix = ''; searchUnavailable = false;
  stages.length = 0; searches.length = 0; acquired.length = 0; documents.length = 0; evaluations.length = 0;
  finalText = ''; finalInput = ''; finalEvidence = [];
  saved = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  for (const log of [logger, aiLogger]) for (const level of ['info', 'warn', 'error', 'debug'] as const)
    jest.spyOn(log, level).mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  publisher.mockImplementation(async (url: string, options: any) => {
    const parsed = new URL(url);
    expect(parsed.hostname).toBe('93.184.216.34');
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, responseType: 'stream', signal: expect.any(Object) });
    expect(options.headers).not.toHaveProperty('Authorization'); expect(options.headers).not.toHaveProperty('Cookie');
    expect(new Headers(options.headers).has('x-subscription-token')).toBe(false);
    const publicUrl = `https://${options.headers.Host}${parsed.pathname}${parsed.search}`;
    acquired.push(publicUrl);
    const page = scenario.pages.find(value => value.url === publicUrl);
    if (!page) return { status: 404, headers: {}, data: 'No authored fixture exists for this URL.' };
    return { status: 200, headers: { 'content-type': 'text/html' }, data: `<html><title>${page.title}</title><body><article>`
      + `<h1>${page.title}</h1>${page.body}${sourceSuffix}</article><nav>Related guides for other games</nav></body></html>` };
  });
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('https://api.search.brave.com');
    expect(options?.redirect).toBe('error'); expect(options?.signal).toBeDefined();
    searches.push(url.searchParams.get('q')!);
    if (searchUnavailable) return new Response('Search unavailable.', { status: 503 });
    return new Response(JSON.stringify({ web: { results: scenario.pages.map(page => ({ url: page.url,
      title: page.title, description: `${scenario.game} ${scenario.question}` })) } }), { headers: { 'content-type': 'application/json' } });
  });
  sdk.mockImplementation(async (payload: any) => {
    const input = messageText(payload);
    let output: string;
    if (input.includes('Audit the actual Gaming player-facing ANSWER')) {
      stages.push('answer_audit');
      throw new Error('The retired independent answer audit was dispatched.');
    }
    if (payload.text?.format?.name?.startsWith('trinity_structured_reasoning')) {
      stages.push('reasoning');
      output = JSON.stringify({ reasoning_steps: [], assumptions: [], constraints: [], tradeoffs: [], alternatives_considered: [],
        chosen_path_justification: '', response_mode: 'answer', achievable_subtasks: ['answer only acquired gameplay claims'],
        blocked_subtasks: [], user_visible_caveats: [], claim_tags: [], final_answer: draft(payload) });
    } else if (input.includes('Gaming guide intake policy: compact-v1')) {
      stages.push('intake'); output = 'Use the acquired guide passages, preserve qualifications and spoiler limits, and cite each factual recommendation.';
    } else {
      stages.push('final');
      const trusted = messageText({ input: payload.input.filter((message: any) => message.role === 'system' || message.role === 'developer') });
      expect(trusted).toContain('Gaming CLEAR Presentation policy: gaming-clear-presentation/v1');
      finalInput = input;
      finalEvidence = [...input.matchAll(/\[Source (\d+)\]\s*\nOrigin:[^\n]*\nURL: (https:\/\/[^\s"\\]+)([\s\S]*?)(?=\[Source \d+\]|\[END UNTRUSTED WEB EVIDENCE\]|$)/gu)]
        .map(match => ({ sourceIndex: Number(match[1]), url: match[2], text: match[3] }));
      finalText = draft(payload, true);
      output = finalText;
    }
    return { id: `heldout-sdk-${stages.length}`, model: payload.model, status: 'completed', output: [], output_text: output,
      usage: { input_tokens: 90, output_tokens: 45, total_tokens: 135 } };
  });
});
afterEach(() => {
  expect(write).not.toHaveBeenCalled();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  jest.restoreAllMocks(); resetSafetyRuntimeStateForTests();
});

function harness(backend: boolean) {
  if (backend) process.env.ARCANOS_GAMING_HYBRID_BACKEND_DISCOVERY_ENABLED = 'true';
  else delete process.env.ARCANOS_GAMING_HYBRID_BACKEND_DISCOVERY_ENABLED;
  const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }),
    ingest: write as never, evaluateCandidates: async (input, context, dependencies) => {
      const value = await evaluateGamingHybridCandidates(input, context, { ...dependencies, resolveDocument: async (...args) => {
        const document = await resolveGamingDocument(...args); documents.push(document); return document;
      } });
      evaluations.push(value); return value;
    } });
  const execute = createGamingMcpExecutor({ hybridQuery: workflow.query, candidates: workflow.candidates, ingestCandidates: workflow.ingest });
  const app = express();
  app.use(createChatGptGamingMcpRouter({ configuration, verification: { keyResolver: jwks, readEnvironmentValue: () => undefined },
    providerAdmission: (_req, _res, next) => next(), execute }));
  let sequence = 0;
  async function invoke(name: 'arcanos_gaming_hybrid_query' | 'arcanos_gaming_submit_candidates', input: unknown, subject = 'heldout-owner') {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: subject,
      iat: now, exp: now + 300, scope: GAMING_QUERY_SCOPE }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'heldout-gaming' }).sign(keys.privateKey);
    const response = await request(app).post(GAMING_MCP_PATH).set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${token}`).send({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: input } });
    if (subject !== 'heldout-owner') return { transportStatus: response.status, body: response.body };
    expect(response.status).toBe(200);
    expect(isGamingMcpOutput(name, response.body.result.structuredContent)).toBe(true);
    return response.body.result.structuredContent as { statusCode: number; result: GamingHybridResponse };
  }
  const payload = { contractVersion: 'gaming-hybrid-v2', game: scenario.game, question: scenario.question,
    idempotencyKey: `heldout-query-${scenario.id}`, storagePolicy: 'transient_only' };
  const query = (overrides: Record<string, unknown> = {}) => invoke('arcanos_gaming_hybrid_query', { ...payload, ...overrides }) as Promise<{ statusCode: number; result: GamingHybridResponse }>;
  async function complete() {
    let result = await query();
    if (!backend) {
      expect(result.result).toMatchObject({ revision: 0, nextAction: 'search', discovery: { continuationRequired: true } });
      expect(searches).toEqual([]); expect(acquired).toEqual([]); expect(stages).toEqual([]);
      const found = await discoverGamingSources({ game: scenario.game, prompt: scenario.question, mode: 'guide', queryVariants: true,
        provider: createBraveGamingSearchProvider() });
      expect(found.discoveryFailureReason).toBeUndefined();
      result = await invoke('arcanos_gaming_submit_candidates', { contractVersion: 'gaming-hybrid-v2',
        workflowId: result.result.workflowId, expectedRevision: result.result.revision, idempotencyKey: `heldout-submit-${scenario.id}`,
        discoveryType: 'gameplay_evidence', candidates: found.candidates.map(candidate => ({ url: candidate.url })) }) as typeof result;
    }
    return result;
  }
  return { query, complete, invoke, payload };
}

describe.each([false, true])('held-out SYNTHETIC full-path acceptance, backend discovery %s', backend => {
  it.each(scenarios)('answers exact question $id with presented guidance and independently checked fixture citations', async fixture => {
    scenario = fixture;
    const app = harness(backend);
    const result = await app.complete();
    expect(result.statusCode === 200 ? undefined : { reason: result.result.reason, stages,
      warnings: jest.mocked(logger.warn).mock.calls }).toBeUndefined();
    expect(result).toMatchObject({ statusCode: 200, result: { state: 'answer_ready', nextAction: 'answer', revision: 1,
      evidenceSelected: true, coverageSatisfied: true, answer: { provenance: 'arcanos-trinity' } } });
    const answer = result.result.answer!;
    for (const claim of fixture.claims) {
      expect(answer.response).toMatch(claim.answerProbe);
      const line = answer.response.split('\n').find(value => claim.answerProbe.test(value))!;
      const index = Number(/\[(\d+)\]/u.exec(line)?.[1]);
      expect(answer.sources[index - 1]?.url).toBe(claim.url);
      expect(finalEvidence.some(chunk => chunk.sourceIndex === index && chunk.url === claim.url
        && claim.support.every(probe => probe.test(chunk.text)))).toBe(true);
    }
    expect(answer.response).not.toMatch(/9999|SPOILER_SENTINEL|currently optimal|verified current/iu);
    if (fixture.advisory) expect(answer.response).toContain('Current patch compatibility could not be verified');
    expect(answer.sources.every(source => fixture.pages.some(page => page.url === source.url) && source.fetchedAt)).toBe(true);
    expect(documents.every(document => document.acquisition && document.metrics.instructionFiltered === false)).toBe(true);
    expect(evaluations.every(value => value.accepted.every(candidate => candidate.sourceAssessment.gates.identity === 'verified'
      && candidate.sourceAssessment.gates.security === 'verified' && candidate.sourceAssessment.gates.claimSupport === 'verified'))).toBe(true);
    if (fixture.id === 'C') {
      // Preserve this measured limitation: the acquired prose scope is not
      // extracted as applicability metadata or selected as generation evidence.
      // The draft therefore withholds positive platform/edition/patch claims.
      expect(documents[0].text).toContain('PC Live 4.0');
      expect(documents[0].text).toContain('19.02');
      expect(finalEvidence.every(chunk => !chunk.text.includes('PC Live 4.0'))).toBe(true);
      expect(answer.response).not.toMatch(/19\.02|PC Live 4\.0/u);
    }
    expect(result.result.selectedEvidenceIds!.length).toBeGreaterThan(0);
    for (const recordId of result.result.selectedEvidenceIds!) {
      const candidate = evaluations.flatMap(value => value.accepted).find(value => recordId.startsWith(value.candidateId + ':'));
      const record = candidate?.evidenceRecords?.find(value => value.recordId === recordId);
      expect(record?.revisionId).toBe(candidate?.contentHash);
      expect(record?.revisionId).toBeDefined();
      const ordinal = Number(recordId.split(':').at(-1));
      expect(finalEvidence.some(chunk => chunk.url === candidate?.publicUrl
        && chunk.text.split('\n').includes('Passage: ' + (ordinal + 1)))).toBe(true);
    }
    expect(answer.response).toContain(finalText);
    if (fixture.id === 'B' || fixture.id === 'D') expect(finalInput).toContain('Spoilers: none');
    expect(result.result.requirementSupport!.length).toBeGreaterThan(0);
    expect(result.result.requirementSupport!.every(link => link.evidenceIds.every(id => result.result.selectedEvidenceIds!.includes(id)))).toBe(true);
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(searches).toHaveLength(2); expect(new Set(searches).size).toBe(2);
    expect(acquired.sort()).toEqual(fixture.pages.map(page => page.url).sort());
    const callCount = sdk.mock.calls.length;
    expect((await app.query()).result.answer).toEqual(answer);
    expect(sdk).toHaveBeenCalledTimes(callCount); expect(searches).toHaveLength(2);
  });

  it('leaves factual generation responsibility with Trinity even when an unsupported quantity has a structurally valid citation', async () => {
    adversarialFinal = 'unsupported_quantity';
    const result = await harness(backend).complete();
    expect(result.result.state).toBe('answer_ready');
    expect(result.result.answer?.response).toContain('The Deku Shield costs 9999 Rupees. [1]');
    expect(finalEvidence).not.toHaveLength(0);
    expect(finalEvidence.every(chunk => !chunk.text.includes('9999'))).toBe(true);
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(sdk).toHaveBeenCalledTimes(3);
  });

  it('rejects a numbered citation linking to another independently accepted source', async () => {
    scenario = scenarios[3];
    adversarialFinal = 'wrong_citation_url';
    const result = await harness(backend).complete();
    expect(result.result).toMatchObject({ coverageSatisfied: true, reason: 'GENERATION_UNAVAILABLE' });
    expect(result.result.answer).toBeUndefined();
    expect(finalText).toContain('](' + scenario.pages[1].url + ')');
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(sdk).toHaveBeenCalledTimes(3);
  });

  it('withholds sources prohibiting automated use before any model work', async () => {
    sourceSuffix = '<footer>No automated use.</footer>';
    const result = await harness(backend).complete();
    expect(result.result.answer).toBeUndefined(); expect(stages).toEqual([]); expect(modelLookup).not.toHaveBeenCalled();
    expect(evaluations.flatMap(value => value.decisions).some(value => value.reasonCodes.includes('SOURCE_USE_RESTRICTED'))).toBe(true);
  });
  it('fails owner authorization before search, acquisition or model dispatch', async () => {
    const app = harness(backend);
    const denied = await app.invoke('arcanos_gaming_hybrid_query', app.payload, 'different-owner') as any;
    expect([401, 403]).toContain(denied.transportStatus);
    expect(searches).toEqual([]); expect(acquired).toEqual([]); expect(sdk).not.toHaveBeenCalled();
  });
  it('keeps an ambiguous coordinated expansion requirement unverified instead of assuming base-game applicability', async () => {
    scenario = scenarios[1];
    sourceSuffix = '<p>These Samurai recommendations require no expansion equipment or later-story rewards.</p>';
    const result = await harness(backend).complete();
    expect(result.result.answer).toBeUndefined(); expect(stages).toEqual([]);
    expect(evaluations.flatMap(value => value.decisions).some(value => value.reasonCodes.includes('EDITION_UNVERIFIED'))).toBe(true);
  });
});

it('does not turn an unavailable search provider into invented discovery or missing gameplay evidence', async () => {
  searchUnavailable = true;
  const result = await harness(true).query();
  expect(result.result).toMatchObject({ revision: 0, nextAction: 'search', reason: 'DISCOVERY_PROVIDER_ERROR',
    discovery: { continuationRequired: true, remainingCandidateUrls: 6, remainingTotalAcquisitionMs: 24000 } });
  expect(acquired).toEqual([]); expect(sdk).not.toHaveBeenCalled();
});
