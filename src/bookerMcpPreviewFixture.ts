import express from 'express';
import { createHash } from 'node:crypto';
import { createLocalJWKSet } from 'jose';
import type { JobData } from '@core/db/schema.js';
import { getRequestAbortSignal } from '@arcanos/runtime/requestAbort';
import { createChatGptBookerMcpRouterCore } from './routes/chatgptBookerMcpCore.js';
import { createBookerMcpExecutorCore, type BookerMcpServices } from './chatgpt/bookerCore.js';
import { bookerPrincipalActorKey, createBookerTokenVerifierCore, readBookerAuthConfigurationCore } from './chatgpt/bookerAuthCore.js';
import { BOOKER_PREVIEW_PUBLIC_JWK, BOOKER_PREVIEW_ISSUER, BOOKER_PREVIEW_SUBJECT,
  BOOKER_PREVIEW_CLIENT_ID, BOOKER_PREVIEW_UNIVERSE_ID } from '../scripts/booker-mcp-preview-key.mjs';
import { BOOKER_MCP_PATH, BOOKER_METADATA_PATH } from './shared/chatgpt/bookerMcpContract.js';
import { buildBackstageContinuityResponse, isBackstageContinuityCursorRequestValid } from './shared/backstage/backstageContinuityQueryCore.js';
import { normalizeBackstageNotionScopePath } from './shared/backstage/backstageNotionScopeIndex.js';
import { resolveBackstageNotionSnapshotStatusObservation } from './shared/backstage/backstageNotionSnapshotStatus.js';
import { simulateBackstageMatchCore } from './shared/backstage/backstageMatchSimulationCore.js';
import { buildBackstageBookerClearGenerationPolicy, BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER } from '@services/backstageBookerClear.js';
import { buildBackstageBookerProtectedFailureState } from './shared/backstage/backstageBookerAsyncContinuation.js';
import { buildProtectedBackstageFailureEnvelope } from './shared/backstage/backstageProtectedFailure.js';
import { readBackstageBookerAsyncResultCore } from './shared/backstage/backstageBookerAsyncResultCore.js';
import { protectBackstageQueuedGptJobOutput } from './shared/backstage/backstageQueuedJobResultProtection.js';
import { resolveBackstageJobPayloadProtectionConfig, sealBackstageJobPayload } from './shared/backstage/backstageJobPayloadProtection.js';
import { buildGptIdempotencyScopeHash } from './shared/gpt/gptIdempotency.js';

export const BOOKER_PREVIEW_EVIDENCE_PATH = '/chatgpt/booker/preview-evidence';
export const BOOKER_PREVIEW_PROOF_HEADER = 'x-arcanos-preview-chatgpt-booker-version';
export const BOOKER_PREVIEW_PROOF_VERSION = 'chatgpt-booker-mcp-core/v1';
const universeId = BOOKER_PREVIEW_UNIVERSE_ID;
const timestamp = '2026-10-23T00:00:00.000Z';
const hrc = Object.freeze({ fidelity: 1, resilience: 1, verdict: 'Deterministic synthetic HRC; no provider execution.' });
const provenance = Object.freeze({ version: 1, protected: true, protectedGenerationCompleted: true, official: true,
  continuityVerified: true, authority: 'notion', snapshotStatus: 'current_complete', fallbackUsed: false, fallbackPermitted: false });
const materials = [
  { pageTitle: 'Raw', pagePath: ['Universe', 'Raw'], headingPath: ['Main event'], text: 'Synthetic A holds the Raw championship.' },
  { pageTitle: 'Raw', pagePath: ['Universe', 'Raw'], headingPath: ['Opening'], text: 'Kay "Spotlight" Morales opens the synthetic Raw show.' },
  { pageTitle: 'Raw Results', pagePath: ['Universe', 'Raw', 'Raw Results'], headingPath: ['Results'], text: 'Synthetic B won the prior Raw exhibition.' },
  { pageTitle: 'Smackdown', pagePath: ['Universe', 'Smackdown'], headingPath: ['Main event'], text: 'Synthetic C holds the Smackdown championship.' },
];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equalPath = (left: readonly string[], right: readonly string[]) => JSON.stringify(normalizeBackstageNotionScopePath(left))
  === JSON.stringify(normalizeBackstageNotionScopePath(right));
const prefixPath = (left: readonly string[], right: readonly string[]) => left.length <= right.length && equalPath(left, right.slice(0, left.length));
const route = (action: string) => ({ gptId: 'backstage-booker', module: 'BACKSTAGE:BOOKER', route: 'backstage-booker', action, timestamp });
const success = (action: string, result: unknown) => ({ statusCode: 200, result: { ok: true, result, _route: route(action) } });
const unavailable = (code = 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE', statusCode = 503) => ({ statusCode,
  result: { ok: false, ...buildBackstageBookerProtectedFailureState({ code, message: 'Synthetic authority rejected this operation; no fallback or canon write.' }) } });
type FixtureJob = { job: JobData; mode: string; polls: number; terminal: unknown };

/** HTTPS identity is supplied by the sealed launcher, never inferred from request headers. */
export function createBookerMcpPreviewFixture(origin: string) {
  if (!/^https:\/\/[a-z0-9][a-z0-9-]*pr-676861-1566[a-z0-9-]*\.up\.railway\.app$/u.test(origin)) throw new Error('BOOKER_PREVIEW_ORIGIN_INVALID');
  const configuration = readBookerAuthConfigurationCore(name => ({
    CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: BOOKER_PREVIEW_ISSUER,
    CHATGPT_BOOKER_RESOURCE: origin + BOOKER_MCP_PATH, CHATGPT_BOOKER_JWKS_URL: BOOKER_PREVIEW_ISSUER + 'jwks',
    CHATGPT_BOOKER_OWNER_SUBJECT: BOOKER_PREVIEW_SUBJECT, CHATGPT_BOOKER_UNIVERSE_ID: universeId,
    CHATGPT_BOOKER_OAUTH_CLIENT_ID: BOOKER_PREVIEW_CLIENT_ID,
  })[name]);
  if (configuration.status !== 'ready') throw new Error('BOOKER_PREVIEW_CONFIGURATION_INVALID');
  const verification = { keyResolver: createLocalJWKSet({ keys: [BOOKER_PREVIEW_PUBLIC_JWK] }), readEnvironmentValue: () => undefined };
  const verify = createBookerTokenVerifierCore(configuration, verification);
  // Public synthetic encryption material belongs only to this bounded process-local fixture.
  const payloadProtectionConfig = resolveBackstageJobPayloadProtectionConfig(name =>
    name === 'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY' ? Buffer.alloc(32, 0x36).toString('base64') : undefined);
  const jobs = new Map<string, FixtureJob>();
  const idempotency = new Map<string, string>();
  let syntheticExecutions = 0;
  let providerAdmissions = 0;
  let pollingReads = 0;
  let stopped = false;
  const executionCounts = new Map<string, number>();
  const generation = (action: string) => {
    const policy = buildBackstageBookerClearGenerationPolicy();
    if (!policy.includes(BACKSTAGE_BOOKER_CLEAR_GENERATION_POLICY_MARKER)) throw new Error('BOOKER_PREVIEW_CLEAR_INVALID');
    return success(action, { universeId,
      storyline: 'Kay "Spotlight" Morales presents a deterministic synthetic booking grounded only in the synthetic Raw snapshot.',
      protectedGeneration: provenance, ...(action === 'generateBookingWithHRC' ? { hrc } : {}) });
  };
  const services: BookerMcpServices = {
    async run(principal, action, payload, options) {
      getRequestAbortSignal()?.throwIfAborted();
      if (stopped) return unavailable();
      if (action === 'queryContinuity') {
        if (payload.query === 'fixture:stale' || payload.query === 'fixture:unavailable') {
          const snapshot = resolveBackstageNotionSnapshotStatusObservation({ activeSnapshotPresent: payload.query !== 'fixture:unavailable',
            activeSnapshotReadable: true, activeSnapshotVerifiedAt: new Date('2026-10-20T00:00:00.000Z'),
            now: new Date(timestamp), maximumStalenessMs: 60_000, latestSyncAttempt: null });
          if (snapshot.status === 'current_complete') throw new Error('BOOKER_PREVIEW_STALE_FIXTURE_INVALID');
          return unavailable();
        }
        if (payload.query !== 'fixture:continuity' || !isBackstageContinuityCursorRequestValid(payload)) return unavailable();
        const scope = payload.retrievalScope as { pageTitle?: string; pagePath?: string[]; sectionPath?: string[]; scopeKind?: 'subtree' } | undefined;
        const selected = materials.filter(material => (!scope?.pageTitle || scope.scopeKind === 'subtree'
          ? !scope?.pagePath || prefixPath(scope.pagePath, material.pagePath)
          : material.pageTitle === scope.pageTitle && (!scope.pagePath || equalPath(scope.pagePath, material.pagePath)))
          && (!scope?.sectionPath || prefixPath(scope.sectionPath, material.headingPath)));
        if (!selected.length) return unavailable();
        const cursor = Buffer.from(digest({ snapshot: 'synthetic-current-complete-v1', scope, query: payload.query })).toString('base64url');
        if (payload.cursor !== undefined && payload.cursor !== cursor) return unavailable('BACKSTAGE_NOTION_CURSOR_INVALID', 409);
        const paged = payload.retrievalMode === 'complete_scope';
        const page = paged ? selected.slice(payload.cursor === undefined ? 0 : 2, payload.cursor === undefined ? 2 : 4) : selected;
        const hasMore = paged && payload.cursor === undefined && selected.length > 2;
        const pages = new Set(selected.map(material => material.pagePath.join('/'))).size;
        const selectedPages = new Set(page.map(material => material.pagePath.join('/'))).size;
        const coverage = { status: page.length === selected.length ? 'complete' as const : 'sampled' as const,
          scopeChunks: selected.length, selectedChunks: page.length, omittedChunks: selected.length - page.length,
          promptTruncated: false, exhaustive: !paged || !hasMore, hasMore, ...(hasMore ? { nextCursor: cursor } : {}) };
        return success(action, buildBackstageContinuityResponse({ universeId, query: String(payload.query) }, {
          snapshotStatus: 'current_complete', resolvedScope: scope?.pageTitle ? { pageTitle: scope.pageTitle,
            pagePath: scope.pagePath ?? [], ...(scope.sectionPath ? { sectionPath: scope.sectionPath } : {}),
            ...(scope.scopeKind ? { scopeKind: scope.scopeKind } : {}) } : null,
          coverage: scope?.scopeKind === 'subtree' ? { ...coverage, scopePages: pages, selectedPages, omittedPages: pages - selectedPages } : coverage,
          citations: page.map(material => ({ ...material, category: 'raw', chunkId: digest(material), contentHash: digest(material.text) })),
        }, page.map(material => '- ' + material.text).join('\n')));
      }
      if (action === 'simulateMatch') {
        const rolls = [0.05, 0, 0.9, 0.5, 0.75];
        const result = simulateBackstageMatchCore(payload.match as Parameters<typeof simulateBackstageMatchCore>[0],
          (payload.rosters ?? []) as Parameters<typeof simulateBackstageMatchCore>[1], Number(payload.winProbModifier ?? 0),
          () => rolls.shift() ?? 0.5);
        return success(action, { universeId, result, hrc });
      }
      if (payload.prompt === 'fixture:protected-failure') return unavailable('BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE');
      const mode = /^fixture:async:(completed|cancelled|failed)$/u.exec(String(payload.prompt))?.[1];
      if (!mode) {
        if (payload.prompt !== 'fixture:booking' && payload.prompt !== 'fixture:hrc') return unavailable();
        syntheticExecutions++;
        return generation(action);
      }
      if (!options.idempotencyKey) return unavailable();
      const actor = bookerPrincipalActorKey(principal, universeId);
      const key = digest([actor, action, options.idempotencyKey]);
      const existingId = idempotency.get(key);
      if (existingId && jobs.get(existingId)?.mode !== mode) return unavailable('BACKSTAGE_ASYNC_RESULT_UNAVAILABLE', 409);
      let jobId = existingId;
      if (!jobId) {
        if (jobs.size >= 32) return unavailable();
        const hash = digest([key, mode]);
        jobId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        const input = { gptId: 'backstage-booker', routeHint: action, requestPath: '/gpt/backstage-booker',
          protectedBackstage: { version: 1, source: 'backstage-booker-http', envelopeId: jobId, action, universeId,
            sealedPayload: sealBackstageJobPayload({ purpose: 'backstage-booker-job-input',
              identity: { envelopeId: jobId, gptId: 'backstage-booker', action, universeId }, payload: { synthetic: true }, config: payloadProtectionConfig }) } };
        const terminal = mode === 'completed' ? generation(action).result : buildProtectedBackstageFailureEnvelope({
          gptId: 'backstage-booker', action, code: 'BACKSTAGE_ASYNC_EXECUTION_FAILED' });
        const job = { id: jobId, job_type: 'gpt', status: 'pending', input, output: null,
          idempotency_scope_hash: buildGptIdempotencyScopeHash({ surface: 'public-gpt', actorKey: actor }),
          created_at: new Date(timestamp), updated_at: new Date(timestamp) } as JobData;
        jobs.set(jobId, { job, mode, polls: 0, terminal }); idempotency.set(key, jobId);
        if (mode !== 'cancelled') {
          executionCounts.set(jobId, (executionCounts.get(jobId) ?? 0) + 1);
          syntheticExecutions++;
        }
      }
      return { statusCode: 202, result: { ok: true, status: 'queued', jobId,
        poll: `/gpt-access/capabilities/v1/backstage-booker/jobs/${jobId}/result` } };
    },
    universe: async () => { throw { code: 'BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED' }; },
    storyline: async () => { throw { code: 'BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED' }; },
    getJobById: async jobId => jobs.get(jobId)?.job ?? null,
    async job(input, dependencies) {
      input.signal?.throwIfAborted(); pollingReads++;
      const state = jobs.get(input.jobId);
      if (state && ++state.polls >= 2 && state.job.status === 'pending') {
        state.job = { ...state.job, status: state.mode, completed_at: new Date(timestamp),
          output: protectBackstageQueuedGptJobOutput({ jobId: state.job.id, rawInput: state.job.input,
            output: state.terminal, config: payloadProtectionConfig }) } as JobData;
      }
      return readBackstageBookerAsyncResultCore({ ...input, waitForResultMs: 0, pollIntervalMs: 500 }, {
        getJobByIdFn: dependencies.getJobByIdFn!, payloadProtectionConfig,
        waitForQueuedGptJobCompletionFn: async () => { throw new Error('BOOKER_PREVIEW_WAITER_UNEXPECTED'); },
      });
    },
  };
  const router = express.Router();
  router.use((req, res, next) => {
    if ([BOOKER_MCP_PATH, BOOKER_METADATA_PATH, BOOKER_PREVIEW_EVIDENCE_PATH].includes(req.path)) {
      res.setHeader(BOOKER_PREVIEW_PROOF_HEADER, BOOKER_PREVIEW_PROOF_VERSION);
    }
    next();
  });
  router.use(createChatGptBookerMcpRouterCore({ configuration, verification,
    execute: createBookerMcpExecutorCore(services), providerAdmission: (_req, _res, next) => { providerAdmissions++; next(); },
    resolveClientIdentity: req => req.ip ?? 'synthetic', hasUnsafeBlockingConditions: () => stopped,
    runWithProviderAdmission: operation => operation() }));
  const evidence = () => ({ version: BOOKER_PREVIEW_PROOF_VERSION, transport: 'actual-production-core', synthetic: true, syntheticExecutions, providerAdmissions, pollingReads,
    totalJobs: jobs.size, pendingJobs: [...jobs.values()].filter(value => value.job.status === 'pending').length,
    terminalJobs: [...jobs.values()].filter(value => value.job.status !== 'pending').length,
    duplicateExecutions: [...executionCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
    providerRequests: 0, notionRequests: 0, databaseWrites: 0, canonWrites: 0 });
  router.get(BOOKER_PREVIEW_EVIDENCE_PATH, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
    if (count !== 1 || !(await verify(req.header('authorization'))).ok) { res.status(401).json({ error: 'BOOKER_AUTHORIZATION_REQUIRED' }); return; }
    res.json(evidence());
  });
  return { router, evidence, dispose: () => { stopped = true; jobs.clear(); idempotency.clear(); } };
}
