import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import { performance } from 'node:perf_hooks';
import request from 'supertest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';
import type { GamingHybridResponse } from '../src/shared/gaming/gamingHybridContract.js';

// Guide-delivery, authored SYNTHETIC material. These fixtures make no claim that the
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
}
const frontierGuideUrl = 'https://www.elitedangerous.com/news/system-colonisation-guide';
const scenarios: Scenario[] = [
  { id: 'A', game: 'The Legend of Zelda: Ocarina of Time', question: 'Where can I obtain the Deku Shield early in the game?',
    pages: [{ url: 'https://heldout-guides.example/oot/deku-shield-shop', title: 'Ocarina of Time early Deku Shield shop guide',
      body: '<h2>Early equipment</h2><p>In the game The Legend of Zelda: Ocarina of Time, the Kokiri Shop in Kokiri Forest sells the Deku Shield for 40 Rupees. Child Link can buy and equip the Deku Shield before entering the first dungeon. Collect Rupees around Kokiri Forest, then enter the Kokiri Shop to purchase the shield.</p>' }],
    claims: [{ url: 'https://heldout-guides.example/oot/deku-shield-shop',
      draft: 'Child Link can buy the Deku Shield at Kokiri Shop in Kokiri Forest for 40 Rupees early on.',
      answerProbe: /Deku Shield.*Kokiri Shop.*Kokiri Forest.*40 Rupees/iu,
      support: [/Kokiri Shop/iu, /Kokiri Forest/iu, /40 Rupees/iu, /Child Link/iu] }] },
  { id: 'B', game: 'Elden Ring', question: 'How should I build an early-game Samurai without major story spoilers?',
    pages: [{ url: 'https://heldout-guides.example/elden-ring/starting-samurai', title: 'Elden Ring early-game Samurai build guide',
      body: '<p>In the game Elden Ring, an early-game Samurai build uses the starting Uchigatana and Unsheathe skill with base-game equipment. Prioritize Vigor for survival, then meet Dexterity requirements. Raise Endurance enough to retain a medium equipment load rather than heavy rolling.</p><h2>Starting katana upgrades and combat</h2><p>Upgrade the Uchigatana with Smithing Stones at the Church of Elleh smithing table before seeking new weapons. Use a light attack to test an opening, use Unsheathe only after an enemy attack misses, then dodge and recover stamina. These starting Samurai recommendations require no expansion. They use no later-story rewards.</p>' }],
    claims: [{ url: 'https://heldout-guides.example/elden-ring/starting-samurai',
      draft: 'For a spoiler-light base-game Samurai start, retain the Uchigatana and Unsheathe, prioritize Vigor, meet Dexterity requirements, and keep a medium equipment load. Current patch compatibility could not be verified from these excerpts.',
      answerProbe: /Uchigatana.*Unsheathe.*Vigor.*Dexterity.*medium/iu,
      support: [/Uchigatana/iu, /Unsheathe/iu, /Vigor/iu, /Dexterity/iu, /medium/iu] }] },
  { id: 'C', game: 'Elite Dangerous', question: 'Find a detailed guide explaining system colonisation in Elite Dangerous and how to get started, including prerequisites and the first concrete steps. Cite the guide sources.',
    // Both discovery and HTTP are mocked. The public URL identifies the scenario and the bytes are authored.
    pages: [{ url: frontierGuideUrl, title: 'Elite Dangerous system colonisation getting started guide',
      body: '<p>In the game Elite Dangerous, system colonisation begins by selecting an uninhabited candidate system and purchasing a colonisation claim. Travel to the selected system with the claim, deploy the system colonisation ship, and deliver the construction commodities requested by the project. Complete the requested deliveries before the project deadline. Establish a colony in Elite Dangerous’ outer systems.</p><p>Check the project requirements before committing the claim because commodity quantities depend on the selected project. This authored walkthrough does not verify current-patch compatibility.</p>'
        + '<table><tr><th>Mechanic</th><th>Value</th></tr><tr><td>System colonisation</td><td>requires a colonisation claim from a colonisation contact</td></tr></table>' }],
    claims: [{ url: frontierGuideUrl,
      draft: '1. Select an uninhabited system and obtain the required colonisation claim. 2. Deploy the colonisation ship. 3. Deliver the requested construction commodities before the deadline.',
      answerProbe: /1\..*uninhabited system.*colonisation claim.*2\..*colonisation ship.*3\..*construction commodities.*deadline/iu,
      support: [/uninhabited/iu, /colonisation claim/iu, /colonisation ship/iu, /construction commodities/iu, /deadline/iu] },
    { url: frontierGuideUrl,
      draft: 'The selected excerpts do not establish platform or edition compatibility, and current patch compatibility could not be verified.',
      answerProbe: /do not establish platform.*edition.*patch/iu, support: [] }] },
  { id: 'D', game: 'Xenoblade Chronicles 2', question: 'How do I set up Rex for damage and Nia for healing early in Chapter 2?',
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
  { id: 'E', game: 'Ivory Clockwork', question: 'How do I restart the rainwheel at the Amber Locks?',
    pages: [{ url: 'https://heldout-community.example/ivory-clockwork/rainwheel', title: 'Ivory Clockwork Amber Locks rainwheel guide',
      body: '<p>Ivory Clockwork is an exploration game. In the game Ivory Clockwork, restart the rainwheel at the Amber Locks by closing the east sluice, inserting the pearl spindle, and turning the wheel twice. The rainwheel restarts only when the east sluice is closed and the pearl spindle is inserted. Wait for the blue water indicator before reopening the sluice.</p>' }],
    claims: [{ url: 'https://heldout-community.example/ivory-clockwork/rainwheel',
      draft: 'At the Amber Locks, close the east sluice, insert the pearl spindle, and turn the rainwheel twice; wait for the blue water indicator before reopening the sluice.',
      answerProbe: /Amber Locks.*east sluice.*pearl spindle.*twice.*blue water indicator/iu,
      support: [/Amber Locks/iu, /east sluice/iu, /pearl spindle/iu, /twice/iu, /blue water indicator/iu] }] }
];

let scenario = scenarios[0];
let wrongCitation: 'none' | 'out_of_range' | 'mismatched_url' | 'unknown_url' = 'none';
let useNumberedLink = false;
let finalInterruption: 'none' | 'truncation' | 'refusal' | 'tool_output' = 'none';
let sourceSuffix = '';
let sourceTextLimit: number | undefined;
const capabilityRefusal = "I can't browse the web.";
const partialExtractionWarning = 'Some selected source material was only partially extracted. This answer is limited to the intact passages available for review.';
const rainwheelCondition = 'The Amber Locks rainwheel procedure works only while the village gate is open.';
let finalCapabilityRefusal: 'none' | 'only' | 'with_guidance' | 'echoed_warning' | 'warning_only' = 'none';
let finalRefusalText = capabilityRefusal;
let finalQualificationPresentation = '';
let citeFallback = false;
let omitFinalCitations = false;
let searchUnavailable = false;
const stages: string[] = [];
const searches: string[] = [];
const acquired: string[] = [];
const presentationVersion = 'gaming-clear-presentation/v1';
const finalOutputs: string[] = [];
const finalEvidence: Array<{ sourceIndex: number; url: string; text: string }> = [];
let presentSteps = false;
let awkwardAnswer = false;
const fixtureMeasurements: Array<Record<string, unknown>> = [];
const adversarialMeasurements: Array<Record<string, unknown>> = [];
const acquisitionDurations: number[] = [];
let generationStarted = 0;
let generationFinished = 0;
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
/** Capture source blocks from the actual generation payload for citation assertions. */
function readFinalEvidence(text: string) {
  return [...text.matchAll(/\[Source (\d+)\]\s*\nOrigin:[^\n]*\nURL: (https:\/\/[^\s"\\]+)([\s\S]*?)(?=\[Source \d+\]|\[END UNTRUSTED WEB EVIDENCE\]|$)/gu)]
    .map(match => ({ sourceIndex: Number(match[1]), url: match[2], text: match[3] }));
}

/** The controlled SDK models presentation behavior using only authored claims. */
function draft(payload: any, forDelivery = false): string {
  const text = messageText(payload);
  const numbered = [...text.matchAll(/\[Source (\d+)\][\s\S]*?URL: (https:\/\/[^\s"\\]+)/gu)];
  const numberFor = (url: string) => Number(numbered.find(match => match[2].trim() === url)?.[1]);
  return scenario.claims.map((claim, index) => {
    expect(claim.support.filter(probe => !probe.test(text)).map(probe => probe.source)).toEqual([]);
    const source = numberFor(claim.url);
    expect(source).toBeGreaterThan(0);
    const claimDraft = awkwardAnswer && forDelivery ? 'The Deku Shield, yes, Kokiri Shop in Kokiri Forest is where, and 40 Rupees is the cost.'
      : presentSteps && index === 0 && forDelivery ? claim.draft.replace(/ (?=[23]\. )/gu, '\n')
      : presentSteps && index === 0 ? claim.draft.replace(/\d\. /gu, '') + ' ' + claim.draft.replace(/\d\. /gu, '')
      : claim.draft;
    if (forDelivery && wrongCitation === 'out_of_range') return claimDraft + ' [99]';
    const url = forDelivery && wrongCitation === 'mismatched_url' && index === 0 ? scenario.pages[1].url
      : forDelivery && wrongCitation === 'unknown_url' ? 'https://not-selected.example/guide' : claim.url;
    return useNumberedLink || url !== claim.url ? claimDraft + ' [' + source + '](' + url + ')' : claimDraft + ' [' + source + ']';
  }).join('\n\n');
}
beforeEach(() => {
  jest.clearAllMocks(); resetSafetyRuntimeStateForTests(); clearGamingDiscoveryCache();
  scenario = scenarios[0]; wrongCitation = 'none'; finalInterruption = 'none'; sourceSuffix = ''; searchUnavailable = false;
  useNumberedLink = false;
  finalCapabilityRefusal = 'none'; finalRefusalText = capabilityRefusal; sourceTextLimit = undefined; citeFallback = false; presentSteps = false; awkwardAnswer = false;
  finalQualificationPresentation = '';
  omitFinalCitations = false;
  stages.length = 0; searches.length = 0; acquired.length = 0; finalOutputs.length = 0; finalEvidence.length = 0; documents.length = 0; evaluations.length = 0;
  acquisitionDurations.length = 0; generationStarted = 0; generationFinished = 0;
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
    generationStarted ||= performance.now();
    const input = messageText(payload);
    let output: string;
    if (input.includes('Audit the actual Gaming player-facing ANSWER')) {
      stages.push('answer_audit');
      throw new Error('The retired semantic audit must never dispatch in presentation mode.');
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
      const trustedPrompt = messageText({ input: payload.input.filter((message: any) =>
        message.role === 'system' || message.role === 'developer') });
      expect(trustedPrompt).toContain('Gaming CLEAR Presentation policy: ' + presentationVersion);
      expect(trustedPrompt).toMatch(/Clarity[\s\S]*Leverage[\s\S]*Efficiency[\s\S]*Alignment[\s\S]*Resilience/u);
      expect(trustedPrompt).toMatch(/silently draft, review all five dimensions/iu);
      finalEvidence.push(...readFinalEvidence(input));
      switch (finalCapabilityRefusal) {
        case 'only': output = finalRefusalText; break;
        case 'warning_only': output = partialExtractionWarning; break;
        case 'echoed_warning': output = `${partialExtractionWarning}\n\n${capabilityRefusal}`; break;
        default:
          output = draft(payload, true);
          if (finalCapabilityRefusal === 'with_guidance') output = `${finalRefusalText}\n\n${output}`;
      }
      if (citeFallback) output += useNumberedLink ? ` [1](${scenario.pages[0].url})` : ' [1]';
      if (finalQualificationPresentation) output = `${finalQualificationPresentation}\n\n${output}`;
      if (omitFinalCitations) output = output.replace(/ \[\d+\]/gu, '');
      finalOutputs.push(output);
      if (finalInterruption !== 'none') {
        return { id: 'heldout-interrupted-final', model: payload.model,
          status: finalInterruption === 'truncation' ? 'incomplete' : 'completed',
          ...(finalInterruption === 'truncation' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
          output: finalInterruption === 'refusal' ? [{
            type: 'message', content: [{ type: 'refusal', refusal: 'Synthetic final refusal.' }]
          }] : finalInterruption === 'tool_output' ? [{ type: 'web_search_call', status: 'completed' }] : [],
          output_text: output, usage: { input_tokens: 90, output_tokens: 45, total_tokens: 135 } };
      }
    }
    generationFinished = performance.now();
    return { id: 'heldout-sdk-' + stages.length, model: payload.model, status: 'completed', output: [], output_text: output,
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

/** Wire the authenticated MCP workflow with controlled external-service seams. */
function harness(backend: boolean) {
  if (backend) process.env.ARCANOS_GAMING_HYBRID_BACKEND_DISCOVERY_ENABLED = 'true';
  else delete process.env.ARCANOS_GAMING_HYBRID_BACKEND_DISCOVERY_ENABLED;
  const workflow = createGamingHybridWorkflow({ retrieve: async () => ({ context: '', sources: [], evidence: [], sourceKnown: false }),
    ingest: write as never, evaluateCandidates: async (input, context, dependencies) => {
      const value = await evaluateGamingHybridCandidates(input, context, { ...dependencies, resolveDocument: async (url, maxTextChars, options) => {
        const started = performance.now();
        const document = await resolveGamingDocument(url, sourceTextLimit ?? maxTextChars, options); acquisitionDurations.push(performance.now() - started);
        documents.push(document); return document;
      } });
      evaluations.push(value); return value;
    } });
  const execute = createGamingMcpExecutor({ hybridQuery: workflow.query, candidates: workflow.candidates, ingestCandidates: workflow.ingest });
  const app = express();
  app.use(createChatGptGamingMcpRouter({ configuration, verification: { keyResolver: jwks, readEnvironmentValue: () => undefined },
    providerAdmission: (_req, _res, next) => next(), execute }));
  let sequence = 0;
  /** Send one signed fixture operation through the real MCP HTTP boundary. */
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
  /** Follow the granted host-search handoff and submit the authored public URLs. */
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

describe.each([false])('natural guide request delivery, SYNTHETIC external effects, backend discovery %s', backend => {
  it.each(scenarios)('delivers natural question $id after source-bound selection, coverage, and Trinity presentation', async fixture => {
    scenario = fixture;
    const app = harness(backend);
    const started = performance.now();
    const result = await app.complete();
    const response = result.result.answer;
    const citationChecks = fixture.claims.map(claim => {
      const line = response?.response.split('\n').find(value => claim.answerProbe.test(value));
      const index = Number(/\[(\d+)\]/u.exec(line ?? '')?.[1]);
      return Boolean(index && response?.sources[index - 1]?.url === claim.url
        && finalEvidence.some(chunk => chunk.sourceIndex === index && chunk.url === claim.url
          && claim.support.every(probe => probe.test(chunk.text))));
    });
    fixtureMeasurements.push({ scenario: fixture.id, acquiredSources: documents.filter(document => document.acquisition).length,
      attemptedSources: acquired.length, acceptedSources: evaluations.flatMap(value => value.accepted).length,
      selectedSources: result.result.selectedCandidateIds?.length ?? 0, selectedPassages: result.result.selectedEvidenceIds?.length ?? 0,
      coverageSatisfied: result.result.coverageSatisfied === true, answerDelivered: result.result.state === 'answer_ready',
      presentationApplied: finalOutputs.length === 1, citationChecks: citationChecks.length, citationsBound: citationChecks.filter(Boolean).length,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      acquisitionMs: Math.round(acquisitionDurations.reduce((sum, value) => sum + value, 0) * 100) / 100,
      generationMs: Math.round((generationFinished - generationStarted) * 100) / 100,
      syntheticSdkCalls: sdk.mock.calls.length, syntheticUsageTokens: sdk.mock.calls.length * 135,
      failureStage: response ? null : result.result.reason });
    expect(result.result.state === 'answer_ready' ? undefined : { reason: result.result.reason, stages, accepted: evaluations.flatMap(value => value.accepted).length, selected: result.result.selectedEvidenceIds, missing: result.result.missingCoverage,
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
    // The synthetic provider supplies the qualification. This checks delivery
    // preserves it; a real model's judgment remains a separate live gate.
    if (fixture.id === 'B' || fixture.id === 'C')
      expect(answer.response).toMatch(/current patch compatibility could not be verified/iu);
    expect(answer.sources.every(source => fixture.pages.some(page => page.url === source.url) && source.fetchedAt)).toBe(true);
    expect(documents.every(document => document.acquisition && document.metrics.instructionFiltered === false)).toBe(true);
    expect(evaluations.every(value => value.accepted.every(candidate => candidate.sourceAssessment.gates.identity === 'verified'
      && candidate.sourceAssessment.gates.security === 'verified' && candidate.sourceAssessment.gates.claimSupport === 'verified'))).toBe(true);
    expect(result.result.selectedEvidenceIds!.length).toBeGreaterThan(0);
    if (fixture.id === 'C') {
      expect(result.result.selectedEvidenceIds).toHaveLength(2);
      expect(finalEvidence.map(chunk => chunk.text)).toEqual(expect.arrayContaining([
        expect.stringMatching(/requires a colonisation claim/iu), expect.stringMatching(/begins by selecting/iu)
      ]));
    }
    const finalRequest = messageText(sdk.mock.calls[2][0]);
    if (fixture.id === 'B' || fixture.id === 'D') {
      expect(finalRequest).toContain('none');
      expect(finalRequest).toContain(fixture.question);
    }
    expect(answer.response).toContain(finalOutputs[0]);
    expect(result.result.requirementSupport!.length).toBeGreaterThan(0);
    expect(result.result.requirementSupport!.every(link => link.evidenceIds.every(id => result.result.selectedEvidenceIds!.includes(id)))).toBe(true);
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(searches).toHaveLength(2); expect(new Set(searches).size).toBe(2);
    expect(acquired.sort()).toEqual(fixture.pages.map(page => page.url).sort());
    const callCount = sdk.mock.calls.length;
    expect((await app.query()).result.answer).toEqual(answer);
    expect(sdk).toHaveBeenCalledTimes(callCount); expect(searches).toHaveLength(2);
  });

  it('delivers awkward but eligible wording without requesting a quality verdict', async () => {
    awkwardAnswer = true;
    const result = await harness(backend).complete();
    expect(result.result.state).toBe('answer_ready');
    expect(result.result.answer?.response).toBe(finalOutputs[0]);
    expect(finalOutputs[0]).toContain('40 Rupees');
    expect(sdk).toHaveBeenCalledTimes(3);
  });

});

it.each([capabilityRefusal, 'I cannot help with this request.', 'I am unable to answer this question.',
  'I cannot provide that information.'])(
  'withholds a standalone refusal without presenting it as a guide (%s)', async refusal => {
    scenario = scenarios[4];
    finalCapabilityRefusal = 'only';
    finalRefusalText = refusal;
    sourceTextLimit = 900;
    sourceSuffix = `<p>${'The station scenery includes nearby landmarks. '.repeat(25)}</p>`;
    const result = await harness(false).complete();
    expect(result.result).toMatchObject({ coverageSatisfied: true, reason: 'GENERATION_UNAVAILABLE' });
    expect(result.result.answer).toBeUndefined();
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(sdk).toHaveBeenCalledTimes(3);
});

it.each([
  ['echoed_warning', false], ['warning_only', false], ['echoed_warning', true], ['warning_only', true]
] as const)(
  'withholds %s (citation present: %s) without treating source notices as gameplay', async (finalMode, cite) => {
    scenario = scenarios[4];
    finalCapabilityRefusal = finalMode;
    citeFallback = cite;
    sourceTextLimit = 900;
    sourceSuffix = `<p>${'The station scenery includes nearby landmarks. '.repeat(25)}</p>`;
    const result = await harness(false).complete();
    expect(result.result).toMatchObject({ coverageSatisfied: true, reason: 'GENERATION_UNAVAILABLE' });
    expect(result.result.answer).toBeUndefined();
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(sdk).toHaveBeenCalledTimes(3);
  }
);

it.each(['echoed_warning', 'warning_only'] as const)(
  'withholds %s even when followed by a numbered Markdown citation', async finalMode => {
    scenario = scenarios[4];
    finalCapabilityRefusal = finalMode;
    citeFallback = true;
    useNumberedLink = true;
    sourceTextLimit = 900;
    sourceSuffix = `<p>${'The station scenery includes nearby landmarks. '.repeat(25)}</p>`;
    const result = await harness(false).complete();
    expect(result.result).toMatchObject({ coverageSatisfied: true, reason: 'GENERATION_UNAVAILABLE' });
    expect(result.result.answer).toBeUndefined();
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
  }
);

it.each([capabilityRefusal, 'I cannot answer this question in full.'])(
  'delivers substantive cited guidance with its capability and extraction qualifications (%s)', async limitation => {
    scenario = scenarios[4];
    finalCapabilityRefusal = 'with_guidance';
    finalRefusalText = limitation;
    sourceTextLimit = 900;
    sourceSuffix = `<p>${'The station scenery includes nearby landmarks. '.repeat(25)}</p>`;
    const result = await harness(false).complete();
    expect(result.result).toMatchObject({ state: 'answer_ready', coverageSatisfied: true });
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(result.result.answer?.response).toBe(partialExtractionWarning + '\n\n' + finalOutputs[0]);
    expect(finalOutputs[0]).toContain(limitation);
    expect(result.result.answer?.response).toMatch(scenario.claims[0].answerProbe);
});

it.each([
  ['an inline quotation', `The guide note quotes “${partialExtractionWarning}”`, true],
  ['a Markdown quote', `> ${partialExtractionWarning}`, true],
  ['a fenced quotation', `\`\`\`text\n\n${partialExtractionWarning}\n\n\`\`\``, true],
  ['a leading standalone paragraph', partialExtractionWarning, false]
] as const)('requires a standalone server qualification when the final draft contains %s', async (_label, presentation, needsPrefix) => {
    scenario = scenarios[4];
    finalQualificationPresentation = presentation;
    sourceTextLimit = 900;
    sourceSuffix = `<p>${'The station scenery includes nearby landmarks. '.repeat(25)}</p>`;
    const result = await harness(false).complete();
    expect(result.result.state).toBe('answer_ready');
    const prefix = needsPrefix ? `${partialExtractionWarning}\n\n${presentation}` : presentation;
    expect(result.result.answer?.response.startsWith(`${prefix}\n\nAt the Amber Locks`)).toBe(true);
    expect(result.result.answer?.response).toContain(finalOutputs[0]);
  });

it('models an ordered presentation rewrite in the final call without changing the authored facts', async () => {
  scenario = scenarios[2];
  presentSteps = true;
  const result = await harness(false).complete();
  const reasoning = await sdk.mock.results[1].value as { output_text: string };
  const draftAnswer = JSON.parse(reasoning.output_text).final_answer;
  const steps = scenario.claims[0].draft.split(/ (?=[23]\. )/gu);
  expect(draftAnswer.match(/obtain the required colonisation claim/gu)).toHaveLength(2);
  expect(result.result.state).toBe('answer_ready');
  expect(result.result.answer?.response).toContain(steps.join('\n'));
  expect(finalOutputs[0].match(/obtain the required colonisation claim/gu)).toHaveLength(1);
  expect(finalOutputs[0].split(/\n\n/u)[0].replace(/ \[\d+\]$/u, '')).toBe(steps.join('\n'));
  expect(stages).toEqual(['intake', 'reasoning', 'final']);
});

it('retains a material source prerequisite in the presented answer', async () => {
  scenario = { ...scenarios[4], claims: scenarios[4].claims.map(claim => ({
    ...claim, draft: claim.draft + ' Only do this while the village gate is open.',
    support: [...claim.support, /while the village gate is open/u]
  })) };
  sourceSuffix = '<p>' + rainwheelCondition + '</p>';
  const result = await harness(false).complete();
  expect(result.result.state).toBe('answer_ready');
  expect(result.result.answer?.response).toContain('while the village gate is open');
  expect(stages).toEqual(['intake', 'reasoning', 'final']);
});

it.each(['out_of_range', 'mismatched_url', 'unknown_url'] as const)(
  'withholds a completed guide with a structurally invalid citation (%s)', async citation => {
    scenario = scenarios[3];
    wrongCitation = citation;
    const result = await harness(false).complete();
    expect(result.result).toMatchObject({ coverageSatisfied: true, reason: 'GENERATION_UNAVAILABLE' });
    expect(result.result.answer).toBeUndefined();
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(finalOutputs).toHaveLength(1);
    expect(sdk).toHaveBeenCalledTimes(3);
  }
);

it('delivers a presented guide with a numbered Markdown citation to a URL containing parentheses', async () => {
  const url = 'https://heldout-guides.example/oot/Deku_Shield_(Item)';
  const original = scenarios[0];
  scenario = { ...original, pages: original.pages.map(page => ({ ...page, url })),
    claims: original.claims.map(claim => ({ ...claim, url })) };
  useNumberedLink = true;
  const result = await harness(false).complete();
  expect(result.result.state).toBe('answer_ready');
  expect(result.result.answer?.response).toContain(`[1](${url})`);
  expect(stages).toEqual(['intake', 'reasoning', 'final']);
});

it('withholds a complete Elite Dangerous guide missing its explicitly requested citations at structural citation validation', async () => {
  scenario = scenarios[2];
  omitFinalCitations = true;
  const result = await harness(false).complete();
  expect(result.result).toMatchObject({ coverageSatisfied: true, reason: 'GENERATION_UNAVAILABLE' });
  expect(result.result.answer).toBeUndefined();
  expect(stages).toEqual(['intake', 'reasoning', 'final']);
  const response = await sdk.mock.results.at(-1)!.value as { output_text: string };
  for (const claim of scenario.claims) expect(response.output_text).toMatch(claim.answerProbe);
  expect(response.output_text).not.toMatch(/\[\d+\]/u);
});

it.each(['truncation', 'refusal', 'tool_output'] as const)(
  'withholds a supported and cited guide when the final provider response includes %s', async interruption => {
    scenario = scenarios[4];
    finalInterruption = interruption;
    const result = await harness(false).complete();
    expect(result.result).toMatchObject({ coverageSatisfied: true, reason: 'GENERATION_UNAVAILABLE' });
    expect(result.result.answer).toBeUndefined();
    expect(stages).toEqual(['intake', 'reasoning', 'final']);
    expect(finalOutputs).toHaveLength(1);
    expect(sdk).toHaveBeenCalledTimes(3);
  });

it.each([
  'How do I get started with system colonisation?',
  'Find me a guide, explain how to start system colonisation, give me steps, and cite your sources.'
])('delivers supported starting instructions for ordinary presentation wording: %s', async question => {
  scenario = { ...scenarios[2], question };
  const result = await harness(false).complete();
  expect(result.result).toMatchObject({ state: 'answer_ready', evidenceSelected: true, coverageSatisfied: true });
  expect(result.result.answer?.response).toMatch(scenario.claims[0].answerProbe);
  expect(stages).toEqual(['intake', 'reasoning', 'final']);
  expect(finalEvidence.length).toBeGreaterThan(0);
});

it('retains the mandatory coverage gate instead of presenting an unsupported quantity as a qualified answer', async () => {
  scenario = { ...scenarios[2], question: 'How do I get started with system colonisation, including the required quantum crystal quantity?' };
  const result = await harness(false).complete();
  expect(result.result).toMatchObject({ state: 'discovery_required', coverageSatisfied: false,
    reason: 'QUESTION_COVERAGE_INSUFFICIENT', nextAction: 'search' });
  expect(result.result.answer).toBeUndefined();
  expect(stages).toEqual([]);
  expect(sdk).not.toHaveBeenCalled();
});

afterAll(() => {
  console.info('GAMING_GUIDE_DELIVERY_FIXTURE_METRICS ' + JSON.stringify({
    evidenceKind: 'deterministic external-service fixtures; test-harness timings',
    realPublisherCalls: 0, realProviderCalls: 0, realProviderCostUsd: 0, scenarios: fixtureMeasurements
  }));
});


/** Build authored procedural evidence; none of these pages represents a publisher capture. */
function proceduralScenario(question: string, prose: string, claims: Claim[]): Scenario {
  const url = 'https://heldout-guides.example/elite/adversarial-procedure';
  return { id: 'procedural-adversarial', game: 'Elite Dangerous', question,
    pages: [{ url, title: 'Elite Dangerous system colonisation guide', body:
      '<p>In the game Elite Dangerous, system colonisation uses settlement projects and construction deliveries. '
      + 'Inspect the settlement manifest to plan construction deliveries for an existing colony.</p>' + prose }],
    claims: claims.map(claim => ({ ...claim, url })) };
}

/** Record sanitized stages; source bodies, prompts, URLs and actor IDs stay out of this receipt. */
function recordAdversarialResult(label: string, result: { statusCode: number; result: GamingHybridResponse }): void {
  const accepted = evaluations.flatMap(value => value.accepted);
  adversarialMeasurements.push({ case: label, acquiredDocuments: documents.length, acceptedSources: accepted.length,
    identityVerifiedSources: accepted.filter(candidate => candidate.sourceAssessment.gates.identity === 'verified').length,
    sourceClearAccepted: accepted.filter(candidate => candidate.sourceAssessment.decision === 'accept').length,
    selectedPassages: result.result.selectedEvidenceIds?.length ?? 0, coverageSatisfied: result.result.coverageSatisfied,
    state: result.result.state, answerPresent: Boolean(result.result.answer), failureReason: result.result.reason,
    trinityStages: [...stages], syntheticSdkCalls: sdk.mock.calls.length, finalPresentationAttempts: finalOutputs.length,
    realPublisherCalls: 0, realProviderCalls: 0 });
}

/** Check citation membership and the authored support in the actual generation payload. */
function expectPresentedProcedure(result: { statusCode: number; result: GamingHybridResponse }): void {
  recordAdversarialResult(scenario.id, result);
  expect(result.result.state === 'answer_ready' ? undefined : { reason: result.result.reason,
    accepted: evaluations.flatMap(value => value.accepted).length, selected: result.result.selectedEvidenceIds,
    missing: result.result.missingCoverage, stages }).toBeUndefined();
  expect(result.result).toMatchObject({ state: 'answer_ready', coverageSatisfied: true, evidenceSelected: true });
  expect(evaluations.flatMap(value => value.accepted).length).toBeGreaterThan(0);
  expect(stages).toEqual(['intake', 'reasoning', 'final']);
  for (const claim of scenario.claims) {
    const line = result.result.answer!.response.split('\n').find(value => claim.answerProbe.test(value));
    const citation = Number(/\[(\d+)\]/u.exec(line ?? '')?.[1]);
    expect(citation).toBeGreaterThan(0);
    expect(result.result.answer!.sources[citation - 1]?.url).toBe(claim.url);
    expect(finalEvidence.some(chunk => chunk.sourceIndex === citation && chunk.url === claim.url
      && claim.support.every(probe => probe.test(chunk.text)))).toBe(true);
  }
}

describe('authored adversarial procedure facts through authenticated MCP', () => {
  it.each([
    { id: 'sold permits', sentence: 'To begin system colonisation, trade permits are sold at the market.',
      draft: 'The source says trade permits are sold at the market.', support: /trade permits are sold at the market/iu },
    { id: 'unavailable process', sentence: 'To begin system colonisation, the process is currently unavailable.',
      draft: 'The source says the system colonisation process is currently unavailable.', support: /process is currently unavailable/iu },
    { id: 'unanswered question', sentence: 'To begin system colonisation, what do I do?',
      draft: 'The source asks what to do to begin system colonisation.', support: /what do I do/iu }
  ])('does not promote a non-procedure into starting instructions: $id', async fixture => {
    scenario = proceduralScenario('How do I start system colonisation in Elite Dangerous?', `<p>${fixture.sentence}</p>`,
      [{ url: '', draft: fixture.draft, answerProbe: /source/iu, support: [fixture.support] }]);
    const result = await harness(false).complete();
    recordAdversarialResult(`non-procedure-${fixture.id}`, result);
    expect(evaluations.flatMap(value => value.accepted).length).toBeGreaterThan(0);
    expect(result.result).toMatchObject({ coverageSatisfied: false });
    expect(result.result.answer).toBeUndefined();
    expect(stages).toEqual([]);
    expect(sdk).not.toHaveBeenCalled();
  });

  it.each([
    { id: 'ordinary comma', sentence: 'To begin system colonisation, visit the System Colonisation Contact and select a destination.',
      support: [/visit the System Colonisation Contact/iu, /select a destination/iu],
      draft: 'Visit the System Colonisation Contact, then select a destination.' },
    { id: 'start target by action', sentence: 'Start system colonisation by visiting a contact and selecting an unpopulated system.',
      support: [/visiting a contact/iu, /selecting an unpopulated system/iu],
      draft: 'Visit a colonisation contact, then select an unpopulated system.' },
    { id: 'colon imperative', sentence: 'To begin system colonisation: visit the System Colonisation Contact.',
      support: [/To begin system colonisation:/iu, /visit the System Colonisation Contact/iu],
      draft: 'Visit the System Colonisation Contact to begin system colonisation.' }
  ])('delivers an explicit acquired action expressed as $id', async fixture => {
    scenario = proceduralScenario('How do I start system colonisation in Elite Dangerous?', `<p>${fixture.sentence}</p>`,
      [{ url: '', draft: fixture.draft, answerProbe: /Visit/iu, support: fixture.support }]);
    scenario.id = `valid-${fixture.id.replace(/[^a-z0-9]+/giu, '-')}`;
    expectPresentedProcedure(await harness(false).complete());
  });

  it('delivers the first three supported actions without requiring presentation words in the guide', async () => {
    scenario = proceduralScenario('Explain the first three actions needed for system colonisation.',
      '<p>To begin system colonisation, visit the System Colonisation Contact. Next, select an unpopulated system on the colonisation map. '
      + 'Then register the system colonisation claim.</p>',
      [{ url: '', draft: '1. Visit the System Colonisation Contact. 2. Select an unpopulated system. '
        + '3. Register the system colonisation claim.', answerProbe: /1\..*Contact.*2\..*unpopulated.*3\..*register/iu,
        support: [/visit the System Colonisation Contact/iu, /Select an unpopulated system/iu, /register the system colonisation claim/iu] }]);
    scenario.id = 'first-three-actions';
    expectPresentedProcedure(await harness(false).complete());
  });

  it('binds materials and their acquisition locations through ordinary them anaphora', async () => {
    scenario = proceduralScenario('What materials do I need for system colonisation and where can I find them?',
      '<p>For system colonisation, the required materials are palladium and water.</p>'
      + '<p>Buy palladium at the refinery market and collect water at the extraction market.</p>',
      [{ url: '', draft: 'System colonisation requires palladium and water; buy palladium at the refinery market '
        + 'and collect water at the extraction market.', answerProbe: /palladium.*water.*refinery market.*extraction market/iu,
        support: [/required materials are palladium and water/iu, /Buy palladium at the refinery market/iu,
          /collect water at the extraction market/iu] }]);
    scenario.id = 'materials-and-locations';
    expectPresentedProcedure(await harness(false).complete());
  });


  it.each([
    { id: 'unrelated-locations', locations: 'The trading interface is at the orbital concourse. The colony office is at the landing pad.' },
    { id: 'other-material-locations', locations: 'Buy titanium at the refinery market and collect oxygen at the extraction market.' },
    { id: 'missing-water-location', locations: 'Buy palladium at the refinery market. The guide does not establish where to find water.' }
  ])('does not use unsupported locations to resolve material them: $id', async fixture => {
    scenario = proceduralScenario('What materials do I need for system colonisation and where can I find them?',
      '<p>For system colonisation, the required materials are palladium and water.</p>' + `<p>${fixture.locations}</p>`, []);
    const result = await harness(false).complete();
    recordAdversarialResult(fixture.id, result);
    expect(evaluations.flatMap(value => value.accepted).length).toBeGreaterThan(0);
    expect(result.result).toMatchObject({ coverageSatisfied: false });
    expect(result.result.answer).toBeUndefined();
    expect(stages).toEqual([]); expect(sdk).not.toHaveBeenCalled();
  });

  it('keeps an unquoted First Three Actions book as a named acquisition target', async () => {
    scenario = proceduralScenario('Where do I obtain the First Three Actions book?',
      '<p>The First Three Actions book is sold at the orbital depot.</p>',
      [{ url: '', draft: 'Obtain the First Three Actions book at the orbital depot.',
        answerProbe: /First Three Actions.*orbital depot/iu, support: [/First Three Actions book is sold at the orbital depot/iu] }]);
    scenario.id = 'named-action-count-book';
    expectPresentedProcedure(await harness(false).complete());
  });

  it('still rejects acquired wrong-game procedure material before any model stage', async () => {
    scenario = proceduralScenario('How do I start system colonisation in Elite Dangerous?',
      '<p>To begin system colonisation, visit the System Colonisation Contact and select a destination.</p>', []);
    scenario.pages = scenario.pages.map(page => ({ ...page, title: 'EVE Online system colonisation guide',
      body: page.body.replace(/Elite Dangerous/gu, 'EVE Online') }));
    const result = await harness(false).complete();
    recordAdversarialResult('wrong-game', result);
    expect(result.result.answer).toBeUndefined();
    expect(evaluations.flatMap(value => value.accepted)).toHaveLength(0);
    expect(evaluations.flatMap(value => value.decisions).some(value => value.reasonCodes.includes('GAME_MISMATCH'))).toBe(true);
    expect(stages).toEqual([]); expect(sdk).not.toHaveBeenCalled();
  });

  it('keeps explicit source edition conflicts binding before model work', async () => {
    scenario = scenarios[1];
    sourceSuffix = '<p>Edition: Shadow of the Erdtree.</p>';
    const result = await harness(false).complete();
    recordAdversarialResult('wrong-edition', result);
    expect(result.result.answer).toBeUndefined();
    expect(evaluations.flatMap(value => value.accepted)).toHaveLength(0);
    expect(evaluations.flatMap(value => value.decisions).some(value => value.reasonCodes.includes('EDITION_CONFLICT'))).toBe(true);
    expect(stages).toEqual([]); expect(sdk).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  console.info('GAMING_GUIDE_ADVERSARIAL_METRICS ' + JSON.stringify({
    evidenceKind: 'authored synthetic external services; actual authenticated application code', cases: adversarialMeasurements
  }));
});
