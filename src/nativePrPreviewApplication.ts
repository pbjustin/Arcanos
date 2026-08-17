import express from 'express';
import {
  getRequestAbortContext,
  runWithRequestAbortTimeout,
} from '@arcanos/runtime/requestAbort';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createGenericJobsRouter,
  type GenericJobData,
} from './routes/genericJobsRouter.js';
import { runResearchWithAbortDrain } from './routes/_core/researchAbortDrain.js';
import {
  applyBackstageStorylineMutation,
} from './core/db/repositories/backstageStorylineRepository.js';
import {
  NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT,
  NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT,
  NATIVE_PR_PREVIEW_FIXTURE_IDS,
  NATIVE_PR_PREVIEW_GAMING_CONTRACT,
  NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT,
  NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT,
  NATIVE_PR_PREVIEW_MODE,
  NATIVE_PR_PREVIEW_RESEARCH_CONTRACT,
  NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT,
  NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER,
  NATIVE_PR_PREVIEW_TRUST_SCOPE,
  type NativePrPreviewIdentity,
} from './nativePrPreviewContract.js';
import {
  createMcpHttpBodyParser,
  MCP_HTTP_BODY_LIMIT_BYTES,
  resolveConfiguredMcpHttpBodyLimitBytes,
} from './mcp/httpBodyParserCore.js';
import {
  buildResearchStorageTopicComponent,
  isResearchRequestValidationError,
  normalizeResearchHttpRequest,
  RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES,
  RESEARCH_TOPIC_MAX_LENGTH,
  RESEARCH_URL_MAX_ITEMS,
  RESEARCH_URL_MAX_LENGTH,
  RESEARCH_URLS_MAX_AGGREGATE_LENGTH,
  type NormalizedResearchRequest,
  type ResearchRequestInput,
} from './shared/researchRequest.js';
import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
  BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS,
  isBackstageStorylineValidationError,
  parseBackstageStorylinePayload,
  parseBackstageStorylineSerializedPayload,
  selectBackstageStorylineResponseBeats,
  type StorylineBeat,
} from './shared/backstage/backstageStoryline.js';
import {
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS,
  BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX,
  BACKSTAGE_HRC_EVALUATION_TIMEOUT_MS,
  BACKSTAGE_MODULE_ROUTE,
  BACKSTAGE_ROUTE_TIMEOUT_MINIMUM_MS,
  buildBackstageBookerTrinityRunOptions,
  buildBackstageMutationConfirmationFingerprintBody,
  isBackstageGptRoute,
  isBackstageMutationAction,
  resolveBackstageGenerationStageTimeoutMs,
  resolveBackstageGptAction,
} from './shared/backstage/backstageActionPolicy.js';
import {
  isHRCResultCacheable,
  markHRCResultNonCacheableForAbort,
  runCachedHrcEvaluation,
} from './shared/hrcEvaluationPolicy.js';
import {
  GPT_ROUTE_HARD_TIMEOUT_BOUNDS,
  resolveGptRouteHardTimeoutMs,
} from './shared/http/gptRouteTimeout.js';
import {
  sendBoundedJsonResponse,
} from './shared/http/sendBoundedJsonResponse.js';
import {
  isSelfHealingDebugOverrideEligible,
  resolvePredictiveReactiveApproval,
  resolveSelfHealingEffectAuthorization,
  shouldRunSelfHealingController,
  type PredictiveExecutionDisposition,
} from './shared/selfHealPredictiveApproval.js';
import {
  dispatchPublicGamingRequest,
} from './services/gamingPublicDispatcher.js';
import {
  buildPublicGamingCanaryFailure,
  executePublicGamingCanary,
  prepareGuardedPublicGamingCanaryResponse,
} from './services/publicGamingCanary.js';

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESEARCH_RESPONSE_BYTES = 4 * 1024;
const MAX_STORYLINE_RESPONSE_BYTES = 4 * 1024;
const MAX_BACKSTAGE_GENERATION_RESPONSE_BYTES = 4 * 1024;
const MAX_MCP_BODY_CAP_RESPONSE_BYTES = 8 * 1024;
const MAX_SELF_HEAL_APPROVAL_RESPONSE_BYTES = 8 * 1024;
const MAX_GAMING_CANARY_RESPONSE_BYTES = 2 * 1024;
const MAX_GAMING_QUERY_RESPONSE_BYTES = 4 * 1024;
const MAX_GAMING_SOURCE_RESPONSE_BYTES = 8 * 1024;
const MAX_GAMING_SOURCE_REQUEST_BYTES = 16 * 1024;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9]\d*)$/u;
const FIXTURE_ACTOR_KEY = 'operator:native-pr-preview-fixture';
const FIXTURE_TIMESTAMP = new Date('2026-07-30T00:00:00.000Z');
const FIXTURE_COMPLETED_TIMESTAMP = new Date('2026-07-30T00:00:01.000Z');
const SAFE_SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PREVIEW_DEFAULT_REQUEST_ID = 'native-pr-preview';
const PREVIEW_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'mcp-session-id',
  'x-action-secret',
  'x-confirmed',
  'x-one-time-token',
  'x-openai-action-secret',
  'x-session-id',
]);
const SENSITIVE_HEADER_SEGMENT_PATTERN =
  /(?:^|-)(?:authorization|cookie|credential|key|secret|session|token)(?:-|$)/u;
const RESEARCH_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures)
);
const STORYLINE_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.fixtures)
);
const BACKSTAGE_GENERATION_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT.fixtures)
);
const MCP_BODY_CAP_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.fixtures)
);
const SELF_HEAL_APPROVAL_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT.fixtures)
);
const GAMING_SOURCE_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtures)
);
const SNAPSHOT_FIRST_URL = 'https://example.invalid/first-snapshot';
const SNAPSHOT_SECOND_URL = 'https://example.invalid/second-snapshot';
const STORAGE_COMPONENT_TOPIC = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RESEARCH_CANCELLATION_TIMEOUT_MS = 150;
const RESEARCH_CANCELLATION_PARENT_TIMEOUT_MS = 1_000;
const RESEARCH_CANCELLATION_DRAIN_DELAY_MS = 50;
const BACKSTAGE_SYNTHETIC_PROVIDER_DELAY_MS = 13_250;
const BACKSTAGE_SYNTHETIC_HRC_TIMEOUT_MS = 25;
const BACKSTAGE_SYNTHETIC_HRC_DELAY_MS = 50;
const RESEARCH_CANCELLATION_STAGES = [
  'dns',
  'fetch',
  'model',
  'persistence',
] as const;
const GAMING_SOURCE_CANONICAL_URL =
  'https://example.invalid/palworld/guide';
const GAMING_SOURCE_VALIDATION_PADDING = 'x'.repeat(
  NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.validationPaddingChars
);
const GAMING_SOURCE_CREATED_AT = '2026-07-30T00:00:00.000Z';
const GAMING_SOURCE_RUNNING_AT = '2026-07-30T00:00:00.500Z';
const GAMING_SOURCE_COMPLETED_AT = '2026-07-30T00:00:01.000Z';

type SyntheticGamingMode = 'guide' | 'build' | 'meta';
type PreviewGamingSourceTargetKind = 'ingestion' | 'refresh' | 'status';

interface PreviewGamingSourceResolution {
  canonical: boolean;
  kind: PreviewGamingSourceTargetKind;
}

type ResearchCancellationStage =
  (typeof RESEARCH_CANCELLATION_STAGES)[number];
type ResearchCancellationTrigger = 'parent-abort' | 'timeout';

export interface NativePrPreviewReadinessState {
  applicationImported: boolean;
  draining: boolean;
  fixturesSealed: boolean;
  ready: boolean;
}

export interface NativePrPreviewApplicationOptions {
  identity: NativePrPreviewIdentity;
  readinessState: NativePrPreviewReadinessState;
}

class NativePrPreviewRepositoryUnavailableError extends Error {}

interface SyntheticResearchFixture {
  input: ResearchRequestInput;
  observeSnapshot?: (
    normalized: NormalizedResearchRequest
  ) => Record<string, unknown>;
}

interface SyntheticResearchResult {
  payload: Record<string, unknown>;
  statusCode: number;
}

interface SyntheticResearchCancellationScenario {
  abortStage: ResearchCancellationStage;
  name: string;
  trigger: ResearchCancellationTrigger;
}

interface SyntheticResearchCancellationState {
  abortObserved: boolean;
  abortReason?: unknown;
  activeWork: number;
  activeWorkAtAbortObservation?: number;
  callbackSettled: boolean;
  drainCompleted: boolean;
  laterStageStarts: number;
  mutationCount: number;
  sameWorkflowDeadlineAcrossStages: boolean;
  sameWorkflowSignalAcrossStages: boolean;
  settledStages: ResearchCancellationStage[];
  startedStages: ResearchCancellationStage[];
  workflowDeadlineAt?: number;
  workflowSignal?: AbortSignal;
}

interface SyntheticStorylineResult {
  payload: Record<string, unknown>;
  statusCode: number;
}

interface SyntheticMcpBodyCapProfile {
  configuredMcpLimit: string;
  expectedEffectiveLimitBytes: number;
  globalJsonLimit: string;
  name: string;
}

interface SyntheticMcpParserOutcome {
  accepted: boolean;
  nextCalls: number;
  parsedPaddingLength: number | null;
  rejection: unknown;
  statusCode: number;
}

interface StorylineFixtureRow {
  id: string;
  serializedData: string;
  storageSequence: number;
}

const STORYLINE_TRANSACTION_PHASES = Object.freeze([
  'isolation',
  'advisory-lock',
  'table-write-fence',
  'revision',
  'legacy-backfill',
  'null-cleanup',
  'prune',
  'compact',
  'insert',
  'fresh-read',
]);
const MCP_BODY_CAP_PROFILES: readonly SyntheticMcpBodyCapProfile[] =
  Object.freeze([
    Object.freeze({
      configuredMcpLimit: '8mb',
      expectedEffectiveLimitBytes: MCP_HTTP_BODY_LIMIT_BYTES,
      globalJsonLimit: '10mb',
      name: 'hard-maximum',
    }),
    Object.freeze({
      configuredMcpLimit: '512kb',
      expectedEffectiveLimitBytes: 512 * 1024,
      globalJsonLimit: '10mb',
      name: 'mcp-configured',
    }),
    Object.freeze({
      configuredMcpLimit: '1mb',
      expectedEffectiveLimitBytes: 256 * 1024,
      globalJsonLimit: '256kb',
      name: 'global-json',
    }),
  ]);

function buildSyntheticResearchFixture(
  fixture: string
): SyntheticResearchFixture {
  const fixtures = NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures;
  switch (fixture) {
    case fixtures.topicExact:
      return {
        input: {
          topic: '😀'.repeat(RESEARCH_TOPIC_MAX_LENGTH / 2),
          urls: [],
        },
      };
    case fixtures.topicOver:
      return {
        input: {
          topic:
            `${'😀'.repeat(RESEARCH_TOPIC_MAX_LENGTH / 2)}x`,
          urls: [],
        },
      };
    case fixtures.urlCountExact:
      return {
        input: {
          topic: 'URL count boundary',
          urls: Array.from(
            { length: RESEARCH_URL_MAX_ITEMS },
            () => ' '
          ),
        },
      };
    case fixtures.urlCountOver:
      return {
        input: {
          topic: 'URL count over boundary',
          urls: Array.from(
            { length: RESEARCH_URL_MAX_ITEMS + 1 },
            () => ' '
          ),
        },
      };
    case fixtures.urlItemExact:
      return {
        input: {
          topic: 'URL item boundary',
          urls: ['😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)],
        },
      };
    case fixtures.urlItemOver:
      return {
        input: {
          topic: 'URL item over boundary',
          urls: [
            `${'😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)}x`,
          ],
        },
      };
    case fixtures.urlAggregateExact:
      return {
        input: {
          topic: 'URL aggregate boundary',
          urls: Array.from(
            {
              length:
                RESEARCH_URLS_MAX_AGGREGATE_LENGTH
                / RESEARCH_URL_MAX_LENGTH,
            },
            () => '😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)
          ),
        },
      };
    case fixtures.urlAggregateOver:
      return {
        input: {
          topic: 'URL aggregate over boundary',
          urls: [
            ...Array.from(
              {
                length:
                  RESEARCH_URLS_MAX_AGGREGATE_LENGTH
                  / RESEARCH_URL_MAX_LENGTH,
              },
              () => '😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)
            ),
            'x',
          ],
        },
      };
    case fixtures.urlSnapshot: {
      const sourceUrls = [` ${SNAPSHOT_FIRST_URL} `];
      let descriptorReads = 0;
      const urls = new Proxy(sourceUrls, {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Object.getOwnPropertyDescriptor(target, property);
          if (property !== '0' || !descriptor || !('value' in descriptor)) {
            return descriptor;
          }
          descriptorReads += 1;
          return {
            ...descriptor,
            value:
              descriptorReads === 1
                ? ` ${SNAPSHOT_FIRST_URL} `
                : SNAPSHOT_SECOND_URL,
          };
        },
      });
      return {
        input: { topic: 'URL snapshot', urls },
        observeSnapshot(normalized) {
          sourceUrls[0] = SNAPSHOT_SECOND_URL;
          return {
            descriptorReads,
            normalizedUrl: normalized.urls[0],
            sourceMutationIsolated:
              normalized.urls[0] === SNAPSHOT_FIRST_URL,
          };
        },
      };
    }
    case fixtures.storageComponent:
      return {
        input: { topic: STORAGE_COMPONENT_TOPIC, urls: [] },
      };
    default:
      throw new Error('PREVIEW_RESEARCH_FIXTURE_INVALID');
  }
}

function summarizeNormalizedResearchRequest(
  normalized: NormalizedResearchRequest
): Record<string, number> {
  let urlAggregateLength = 0;
  let urlItemMaxLength = 0;
  for (const url of normalized.urls) {
    urlAggregateLength += url.length;
    urlItemMaxLength = Math.max(urlItemMaxLength, url.length);
  }
  return {
    topicLength: normalized.topic.length,
    urlAggregateLength,
    urlCount: normalized.urls.length,
    urlItemMaxLength,
  };
}

function requireResearchCancellationFixtureInvariant(
  condition: boolean,
  code: string,
): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

function resolveResearchCancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Research cancellation fixture aborted', 'AbortError');
}

function observeResearchCancellationContext(
  state: SyntheticResearchCancellationState,
): NonNullable<ReturnType<typeof getRequestAbortContext>> {
  const context = getRequestAbortContext();
  requireResearchCancellationFixtureInvariant(
    context !== null,
    'PREVIEW_RESEARCH_CANCELLATION_CONTEXT_MISSING',
  );
  if (!state.workflowSignal) {
    state.workflowSignal = context.signal;
    state.workflowDeadlineAt = context.deadlineAt;
  } else {
    state.sameWorkflowSignalAcrossStages =
      state.sameWorkflowSignalAcrossStages
      && state.workflowSignal === context.signal;
    state.sameWorkflowDeadlineAcrossStages =
      state.sameWorkflowDeadlineAcrossStages
      && state.workflowDeadlineAt === context.deadlineAt;
  }
  return context;
}

async function runSyntheticResearchCancellationStages(
  scenario: SyntheticResearchCancellationScenario,
  state: SyntheticResearchCancellationState,
  parentController: AbortController | undefined,
  parentAbortReason: Error | undefined,
): Promise<void> {
  for (const stage of RESEARCH_CANCELLATION_STAGES) {
    const context = observeResearchCancellationContext(state);
    if (context.signal.aborted) {
      state.laterStageStarts += 1;
      throw resolveResearchCancellationReason(context.signal);
    }
    state.startedStages.push(stage);

    if (stage !== scenario.abortStage) {
      await Promise.resolve();
      if (context.signal.aborted) {
        throw resolveResearchCancellationReason(context.signal);
      }
      state.settledStages.push(stage);
      continue;
    }

    state.activeWork += 1;
    await new Promise<void>((_resolve, reject) => {
      let abortHandled = false;
      const onAbort = () => {
        if (abortHandled) {
          return;
        }
        abortHandled = true;
        context.signal.removeEventListener('abort', onAbort);
        state.abortObserved = true;
        state.abortReason = context.signal.reason;
        state.activeWorkAtAbortObservation = state.activeWork;
        void delay(RESEARCH_CANCELLATION_DRAIN_DELAY_MS)
          .then(() => {
            state.activeWork -= 1;
            state.drainCompleted = true;
            state.mutationCount += 1;
            state.settledStages.push(stage);
            reject(resolveResearchCancellationReason(context.signal));
          });
      };

      if (context.signal.aborted) {
        onAbort();
        return;
      }
      context.signal.addEventListener('abort', onAbort, { once: true });
      if (scenario.trigger === 'parent-abort') {
        requireResearchCancellationFixtureInvariant(
          parentController !== undefined && parentAbortReason !== undefined,
          'PREVIEW_RESEARCH_CANCELLATION_PARENT_MISSING',
        );
        void Promise.resolve().then(
          () => parentController.abort(parentAbortReason),
        );
      }
    });
  }
}

async function runSyntheticResearchCancellationScenario(
  scenario: SyntheticResearchCancellationScenario,
): Promise<Record<string, unknown>> {
  const parentController = scenario.trigger === 'parent-abort'
    ? new AbortController()
    : undefined;
  const parentAbortReason = scenario.trigger === 'parent-abort'
    ? new Error('Research cancellation fixture parent aborted')
    : undefined;
  if (parentAbortReason) {
    parentAbortReason.name = 'AbortError';
  }
  const state: SyntheticResearchCancellationState = {
    abortObserved: false,
    activeWork: 0,
    callbackSettled: false,
    drainCompleted: false,
    laterStageStarts: 0,
    mutationCount: 0,
    sameWorkflowDeadlineAcrossStages: true,
    sameWorkflowSignalAcrossStages: true,
    settledStages: [],
    startedStages: [],
  };
  let outwardError: unknown;

  try {
    await runResearchWithAbortDrain(
      {
        abortMessage: 'Research cancellation fixture timed out',
        parentSignal: parentController?.signal,
        requestId: `native-pr-preview-${scenario.name}`,
        timeoutMs:
          scenario.trigger === 'timeout'
            ? RESEARCH_CANCELLATION_TIMEOUT_MS
            : RESEARCH_CANCELLATION_PARENT_TIMEOUT_MS,
      },
      async () => {
        try {
          await runSyntheticResearchCancellationStages(
            scenario,
            state,
            parentController,
            parentAbortReason,
          );
        } finally {
          state.callbackSettled = true;
        }
      },
    );
  } catch (error) {
    outwardError = error;
  }

  const activeWorkAtOutwardSettlement = state.activeWork;
  const callbackSettledAtOutwardSettlement = state.callbackSettled;
  const drainCompletedAtOutwardSettlement = state.drainCompleted;
  const mutationCountAtOutwardSettlement = state.mutationCount;
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  requireResearchCancellationFixtureInvariant(
    outwardError instanceof Error
    && outwardError.name === 'AbortError'
    && outwardError === state.abortReason
    && state.abortObserved
    && state.activeWorkAtAbortObservation === 1
    && activeWorkAtOutwardSettlement === 0
    && callbackSettledAtOutwardSettlement
    && drainCompletedAtOutwardSettlement
    && state.activeWork === activeWorkAtOutwardSettlement
    && state.laterStageStarts === 0
    && state.mutationCount === mutationCountAtOutwardSettlement
    && state.sameWorkflowDeadlineAcrossStages
    && state.sameWorkflowSignalAcrossStages
    && state.workflowSignal?.aborted === true
    && state.startedStages.length
      === RESEARCH_CANCELLATION_STAGES.indexOf(scenario.abortStage) + 1
    && state.startedStages.every(
      (stage, index) => stage === RESEARCH_CANCELLATION_STAGES[index],
    )
    && state.settledStages.length === state.startedStages.length
    && state.settledStages.every(
      (stage, index) => stage === state.startedStages[index],
    ),
    'PREVIEW_RESEARCH_CANCELLATION_INVARIANT_FAILED',
  );

  return {
    abortObserved: true,
    abortReasonName: 'AbortError',
    abortStage: scenario.abortStage,
    activeWorkAtAbortObservation: 1,
    activeWorkAtOutwardSettlement: 0,
    callbackSettledAtOutwardSettlement: true,
    drainCompletedAtOutwardSettlement: true,
    laterStageStarts: 0,
    name: scenario.name,
    noPostOutwardSettlementMutation: true,
    sameWorkflowDeadlineAcrossStages: true,
    sameWorkflowSignalAcrossStages: true,
    settledStages: [...state.settledStages],
    startedStages: [...state.startedStages],
    trigger: scenario.trigger,
  };
}

async function runSyntheticResearchCancellationFixture(
  fixture: string,
): Promise<SyntheticResearchResult> {
  const scenarios: readonly SyntheticResearchCancellationScenario[] = [
    { abortStage: 'dns', name: 'timeout-dns', trigger: 'timeout' },
    { abortStage: 'fetch', name: 'parent-abort-fetch', trigger: 'parent-abort' },
    { abortStage: 'model', name: 'parent-abort-model', trigger: 'parent-abort' },
    {
      abortStage: 'persistence',
      name: 'parent-abort-persistence',
      trigger: 'parent-abort',
    },
  ];
  const results: Record<string, unknown>[] = [];
  for (const scenario of scenarios) {
    results.push(await runSyntheticResearchCancellationScenario(scenario));
  }

  return {
    statusCode: 200,
    payload: {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      durablePersistenceAttempted: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: false,
      fixture,
      memoryBoundaryReached: false,
      networkBoundaryReached: false,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      cancellation: {
        componentExecuted: true,
        noDetachedWorkAtOutwardSettlement: true,
        scenarioCount: results.length,
        scenarios: results,
        syntheticSeams: [...RESEARCH_CANCELLATION_STAGES],
      },
    },
  };
}

async function runSyntheticResearchFixture(
  fixture: string,
): Promise<SyntheticResearchResult> {
  if (
    fixture
    === NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures
      .workflowCancellationDrain
  ) {
    return runSyntheticResearchCancellationFixture(fixture);
  }
  const syntheticFixture = buildSyntheticResearchFixture(fixture);
  let normalized: NormalizedResearchRequest;
  try {
    normalized = normalizeResearchHttpRequest(syntheticFixture.input);
  } catch (error) {
    if (!isResearchRequestValidationError(error)) {
      throw error;
    }
    return {
      statusCode: 400,
      payload: {
        accepted: false,
        confirmationAttempted: false,
        effectsBoundaryReached: false,
        eligibleForConfirmation: false,
        fixture,
        postValidationBoundaryReached: false,
        protectedEffectsEnabled: false,
        schemaVersion: 1,
        validationCompleted: true,
        validationCode: error.code,
      },
    };
  }

  // This marker is intentionally only a post-validation sentinel. The
  // contained preview never imports confirmGate or crosses an effects boundary.
  const payload: Record<string, unknown> = {
    accepted: true,
    confirmationAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: true,
    fixture,
    normalized: summarizeNormalizedResearchRequest(normalized),
    postValidationBoundaryReached: true,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
    validationCompleted: true,
    validationCode: 'VALID',
  };

  if (syntheticFixture.observeSnapshot) {
    payload.snapshot = syntheticFixture.observeSnapshot(normalized);
  }
  if (
    fixture
    === NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures.storageComponent
  ) {
    const first = buildResearchStorageTopicComponent(normalized.topic);
    const second = buildResearchStorageTopicComponent(normalized.topic);
    const bytes = Buffer.byteLength(first, 'utf8');
    payload.storage = {
      ascii: /^[\x00-\x7f]+$/u.test(first),
      bytes,
      component: first,
      deterministic: first === second,
      maxBytes: RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES,
      portablePattern: /^[a-z0-9-]+-[a-f0-9]{64}$/u.test(first),
      withinLimit:
        bytes <= RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES,
    };
  }

  return { payload, statusCode: 200 };
}

function requireMcpBodyCapFixtureInvariant(
  condition: boolean,
  code: string
): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

function buildMcpBodyAtByteLength(targetBytes: number): Buffer {
  const emptyBody = JSON.stringify({ padding: '' });
  const paddingLength = targetBytes - Buffer.byteLength(emptyBody, 'utf8');
  requireMcpBodyCapFixtureInvariant(
    paddingLength >= 0,
    'PREVIEW_MCP_BODY_CAP_TARGET_INVALID'
  );
  const body = Buffer.from(JSON.stringify({
    padding: 'x'.repeat(paddingLength),
  }), 'utf8');
  requireMcpBodyCapFixtureInvariant(
    body.length === targetBytes,
    'PREVIEW_MCP_BODY_CAP_BODY_LENGTH_INVALID'
  );
  return body;
}

async function runMcpParserAgainstServerOwnedBody(
  limitBytes: number,
  bodyBytes: number
): Promise<{
  outcome: SyntheticMcpParserOutcome;
  responseHeaders: Record<string, string>;
}> {
  const body = buildMcpBodyAtByteLength(bodyBytes);
  const firstBoundary = Math.floor(body.length / 3);
  const secondBoundary = Math.floor((body.length * 2) / 3);
  const request = Readable.from([
    body.subarray(0, firstBoundary),
    body.subarray(firstBoundary, secondBoundary),
    body.subarray(secondBoundary),
  ]) as unknown as express.Request;
  request.headers = {
    'content-type': 'application/json',
    'transfer-encoding': 'chunked',
  };
  request.method = 'POST';
  request.url = '/mcp';

  const responseHeaders: Record<string, string> = {};
  const parser = createMcpHttpBodyParser(limitBytes);
  const outcome = await new Promise<SyntheticMcpParserOutcome>((
    resolve,
    reject
  ) => {
    let nextCalls = 0;
    let settled = false;
    let statusCode = 200;
    const finish = (result: SyntheticMcpParserOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const response = {
      setHeader(name: string, value: unknown) {
        responseHeaders[name.toLowerCase()] = String(value);
        return this;
      },
      status(value: number) {
        statusCode = value;
        return this;
      },
      json(value: unknown) {
        finish({
          accepted: false,
          nextCalls,
          parsedPaddingLength: null,
          rejection: value,
          statusCode,
        });
        return this;
      },
    } as unknown as express.Response;

    parser(request, response, (error?: unknown) => {
      if (error !== undefined) {
        settled = true;
        reject(error);
        return;
      }
      nextCalls += 1;
      const parsedBody = request.body as { padding?: unknown } | undefined;
      finish({
        accepted: true,
        nextCalls,
        parsedPaddingLength: typeof parsedBody?.padding === 'string'
          ? parsedBody.padding.length
          : null,
        rejection: null,
        statusCode,
      });
    });
  });

  return { outcome, responseHeaders };
}

async function runMcpBodyCapFixture(
  fixture: string
): Promise<SyntheticResearchResult> {
  requireMcpBodyCapFixtureInvariant(
    fixture
      === NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.fixtures.effectiveLimits,
    'PREVIEW_MCP_BODY_CAP_FIXTURE_INVALID'
  );
  const cases: Record<string, unknown>[] = [];
  for (const profile of MCP_BODY_CAP_PROFILES) {
    const effectiveLimitBytes = resolveConfiguredMcpHttpBodyLimitBytes(
      profile.configuredMcpLimit,
      profile.globalJsonLimit
    );
    requireMcpBodyCapFixtureInvariant(
      effectiveLimitBytes === profile.expectedEffectiveLimitBytes,
      'PREVIEW_MCP_BODY_CAP_EFFECTIVE_LIMIT_INVALID'
    );

    for (const delta of [0, 1] as const) {
      const accepted = delta === 0;
      const bodyBytes = effectiveLimitBytes + delta;
      const { outcome, responseHeaders } =
        await runMcpParserAgainstServerOwnedBody(
          effectiveLimitBytes,
          bodyBytes
        );
      const rejection = outcome.rejection as {
        error?: unknown;
        message?: unknown;
      } | null;
      requireMcpBodyCapFixtureInvariant(
        outcome.accepted === accepted
          && outcome.statusCode === (accepted ? 200 : 413)
          && outcome.nextCalls === (accepted ? 1 : 0)
          && outcome.parsedPaddingLength
            === (accepted ? bodyBytes - 14 : null)
          && responseHeaders['cache-control'] === 'no-store'
          && responseHeaders.pragma === 'no-cache'
          && (
            accepted
              ? rejection === null
              : rejection?.error === 'MCP_REQUEST_TOO_LARGE'
                && rejection.message === 'MCP request body is too large.'
          ),
        'PREVIEW_MCP_BODY_CAP_PARSER_OUTCOME_INVALID'
      );
      cases.push({
        accepted,
        bodyBytes,
        cacheControl: responseHeaders['cache-control'],
        configuredMcpLimit: profile.configuredMcpLimit,
        effectiveLimitBytes,
        globalJsonLimit: profile.globalJsonLimit,
        name: `${profile.name}-${accepted ? 'exact' : 'over'}`,
        nextCalls: outcome.nextCalls,
        parsedPaddingLength: outcome.parsedPaddingLength,
        pragma: responseHeaders.pragma,
        rejection,
        statusCode: outcome.statusCode,
        streamedWithoutContentLength: true,
      });
    }
  }

  return {
    statusCode: 200,
    payload: {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      durablePersistenceAttempted: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: false,
      fixture,
      memoryBoundaryReached: false,
      networkBoundaryReached: false,
      protectedEffectsEnabled: false,
      providerBoundaryReached: false,
      schemaVersion: 1,
      bodyCap: {
        callerBodyControlsProbe: false,
        caseCount: cases.length,
        cases,
        componentExecuted: true,
        hardMaximumBytes: MCP_HTTP_BODY_LIMIT_BYTES,
        profileCount: MCP_BODY_CAP_PROFILES.length,
        serverOwnedBodies: true,
      },
    },
  };
}

function requireStorylineFixtureInvariant(
  condition: boolean,
  code: string
): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

function storylineFixtureId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function storylineSequence(beat: StorylineBeat): number {
  const sequence = beat.sequence;
  requireStorylineFixtureInvariant(
    Number.isSafeInteger(sequence),
    'PREVIEW_BACKSTAGE_STORYLINE_SEQUENCE_INVALID'
  );
  return sequence as number;
}

function buildStorylineBeatAtSerializedBytes(
  sequence: number,
  targetBytes: number
): StorylineBeat {
  const empty = { sequence, padding: '' };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(empty), 'utf8');
  const paddingBytes = targetBytes - envelopeBytes;
  requireStorylineFixtureInvariant(
    paddingBytes >= 0,
    'PREVIEW_BACKSTAGE_STORYLINE_BYTE_FIXTURE_INVALID'
  );
  const emojiCount = Math.floor(paddingBytes / 4);
  const asciiCount = paddingBytes - (emojiCount * 4);
  const beat = {
    sequence,
    padding: `${'😀'.repeat(emojiCount)}${'x'.repeat(asciiCount)}`,
  };
  requireStorylineFixtureInvariant(
    Buffer.byteLength(JSON.stringify(beat), 'utf8') === targetBytes,
    'PREVIEW_BACKSTAGE_STORYLINE_BYTE_FIXTURE_INVALID'
  );
  return beat;
}

function compareStorylineFixtureRows(
  left: StorylineFixtureRow,
  right: StorylineFixtureRow
): number {
  const sequenceOrder = left.storageSequence - right.storageSequence;
  if (sequenceOrder !== 0 || left.id === right.id) {
    return sequenceOrder;
  }
  return left.id < right.id ? -1 : 1;
}

function createStorylineTransactionFixture(
  initialBeats: readonly StorylineBeat[],
  expectedUniverseId = 'legacy'
) {
  let rows: StorylineFixtureRow[] = initialBeats.map((beat, index) => ({
    id: storylineFixtureId(index + 1),
    serializedData: JSON.stringify(beat),
    storageSequence: index + 1,
  }));
  let nextIdSequence = initialBeats.length + 1;
  let nextRevision = 9_001;
  const phases: string[] = [];

  function recordPhase(phase: string): void {
    const expected =
      STORYLINE_TRANSACTION_PHASES[phases.length % STORYLINE_TRANSACTION_PHASES.length];
    requireStorylineFixtureInvariant(
      phase === expected,
      'PREVIEW_BACKSTAGE_STORYLINE_TRANSACTION_PHASE_INVALID'
    );
    phases.push(phase);
  }

  const query = async (
    queryText: unknown,
    parameters: readonly unknown[] = []
  ): Promise<{ rows: unknown[] }> => {
    requireStorylineFixtureInvariant(
      typeof queryText === 'string',
      'PREVIEW_BACKSTAGE_STORYLINE_QUERY_INVALID'
    );
    const sql = queryText.replace(/\s+/gu, ' ').trim();

    if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') {
      recordPhase('isolation');
      return { rows: [] };
    }
    if (sql.includes('SELECT pg_advisory_xact_lock')) {
      recordPhase('advisory-lock');
      requireStorylineFixtureInvariant(
        parameters.length === 2
        && parameters.every(value => Number.isSafeInteger(value)),
        'PREVIEW_BACKSTAGE_STORYLINE_LOCK_INVALID'
      );
      return { rows: [] };
    }
    if (
      sql
      === 'LOCK TABLE backstage_story_beats IN SHARE ROW EXCLUSIVE MODE'
    ) {
      recordPhase('table-write-fence');
      requireStorylineFixtureInvariant(
        parameters.length === 0,
        'PREVIEW_BACKSTAGE_STORYLINE_TABLE_LOCK_INVALID'
      );
      return { rows: [] };
    }
    if (sql === 'SELECT txid_current()::TEXT AS revision') {
      recordPhase('revision');
      const revision = String(nextRevision);
      nextRevision += 1;
      return { rows: [{ revision }] };
    }
    if (sql.startsWith('WITH newest_legacy AS MATERIALIZED')) {
      recordPhase('legacy-backfill');
      requireStorylineFixtureInvariant(
        parameters[0] === BACKSTAGE_STORYLINE_MAX_BYTES
        && parameters[1] === BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS
        && parameters[2] === expectedUniverseId,
        'PREVIEW_BACKSTAGE_STORYLINE_LEGACY_BOUND_INVALID'
      );
      return { rows: [] };
    }
    if (
      sql
      === 'DELETE FROM backstage_story_beats WHERE universe_id = $1 AND serialized_data IS NULL'
    ) {
      recordPhase('null-cleanup');
      requireStorylineFixtureInvariant(
        parameters[0] === expectedUniverseId,
        'PREVIEW_BACKSTAGE_STORYLINE_UNIVERSE_INVALID'
      );
      return { rows: [] };
    }
    if (sql.startsWith('WITH expired AS MATERIALIZED')) {
      recordPhase('prune');
      const retainedBeforeInsert = BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS - 1;
      requireStorylineFixtureInvariant(
        parameters[0] === retainedBeforeInsert
        && parameters[1] === expectedUniverseId,
        'PREVIEW_BACKSTAGE_STORYLINE_RETENTION_BOUND_INVALID'
      );
      rows = [...rows]
        .sort(compareStorylineFixtureRows)
        .slice(-retainedBeforeInsert);
      return { rows: [] };
    }
    if (sql.startsWith('WITH ordered AS MATERIALIZED')) {
      recordPhase('compact');
      requireStorylineFixtureInvariant(
        parameters[0] === expectedUniverseId,
        'PREVIEW_BACKSTAGE_STORYLINE_UNIVERSE_INVALID'
      );
      rows = [...rows]
        .sort(compareStorylineFixtureRows)
        .map((row, index) => ({ ...row, storageSequence: index + 1 }));
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO backstage_story_beats')) {
      recordPhase('insert');
      const serializedData = parameters[0];
      parseBackstageStorylineSerializedPayload(serializedData);
      requireStorylineFixtureInvariant(
        parameters[1] === expectedUniverseId,
        'PREVIEW_BACKSTAGE_STORYLINE_UNIVERSE_INVALID'
      );
      const id = storylineFixtureId(nextIdSequence);
      nextIdSequence += 1;
      rows.push({
        id,
        serializedData: serializedData as string,
        storageSequence:
          Math.max(0, ...rows.map(row => row.storageSequence)) + 1,
      });
      return { rows: [{ id }] };
    }
    if (sql.startsWith('SELECT recent.serialized_data')) {
      recordPhase('fresh-read');
      const insertedId = parameters[0];
      const limit = parameters[1];
      requireStorylineFixtureInvariant(
        typeof insertedId === 'string'
        && limit === BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS
        && parameters[2] === expectedUniverseId,
        'PREVIEW_BACKSTAGE_STORYLINE_READ_BOUND_INVALID'
      );
      const selected = [...rows]
        .sort((left, right) => {
          const leftInserted = left.id === insertedId;
          const rightInserted = right.id === insertedId;
          if (leftInserted !== rightInserted) {
            return leftInserted ? -1 : 1;
          }
          return right.storageSequence - left.storageSequence
            || (right.id < left.id ? -1 : 1);
        })
        .slice(0, BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS)
        .sort(compareStorylineFixtureRows);
      return {
        rows: selected.map(row => ({
          serialized_data: row.serializedData,
        })),
      };
    }

    throw new Error('PREVIEW_BACKSTAGE_STORYLINE_QUERY_INVALID');
  };

  return {
    client: { query } as unknown as Parameters<
      typeof applyBackstageStorylineMutation
    >[0],
    phases,
  };
}

function requireStorylineSequences(
  beats: readonly StorylineBeat[],
  first: number,
  last: number
): number[] {
  const expected = Array.from(
    { length: last - first + 1 },
    (_, index) => first + index
  );
  const actual = beats.map(storylineSequence);
  requireStorylineFixtureInvariant(
    actual.length === expected.length
    && actual.every((sequence, index) => sequence === expected[index]),
    'PREVIEW_BACKSTAGE_STORYLINE_ORDER_INVALID'
  );
  return actual;
}

async function runStorylineLifecycleFixture(
  fixture: string
): Promise<SyntheticStorylineResult> {
  const exactPayload = parseBackstageStorylinePayload(
    buildStorylineBeatAtSerializedBytes(
      101,
      BACKSTAGE_STORYLINE_MAX_BYTES
    )
  );
  const exactSerialized = JSON.stringify(exactPayload);
  const initialBeats = Array.from({ length: 100 }, (_, index) => {
    const sequence = index + 1;
    return parseBackstageStorylinePayload(
      sequence === 2
        ? { sequence, occurredAt: '1900-01-01T00:00:00.000Z' }
        : { sequence }
    );
  });
  const transactionFixture = createStorylineTransactionFixture(initialBeats);
  const firstMutation = await applyBackstageStorylineMutation(
    transactionFixture.client,
    exactSerialized
  );
  const firstSequences = requireStorylineSequences(
    firstMutation.retainedBeats,
    2,
    101
  );
  const firstResponse = selectBackstageStorylineResponseBeats(
    firstMutation.retainedBeats
  );
  const firstResponseSequences = requireStorylineSequences(
    firstResponse,
    77,
    101
  );

  const secondPayload = parseBackstageStorylinePayload({ sequence: 102 });
  const secondMutation = await applyBackstageStorylineMutation(
    transactionFixture.client,
    JSON.stringify(secondPayload)
  );
  const secondSequences = requireStorylineSequences(
    secondMutation.retainedBeats,
    3,
    102
  );
  const secondResponse = selectBackstageStorylineResponseBeats(
    secondMutation.retainedBeats
  );
  const finalResponseSequences = requireStorylineSequences(
    secondResponse,
    78,
    102
  );
  const firstAncientBeatRetained = firstMutation.retainedBeats.some(
    beat => storylineSequence(beat) === 2
      && beat.occurredAt === '1900-01-01T00:00:00.000Z'
  );
  const firstAcceptedBeatIncluded =
    firstSequences.filter(sequence => sequence === 101).length === 1;
  const secondAcceptedBeatIncluded =
    secondSequences.filter(sequence => sequence === 102).length === 1;
  const freshReadObservedPriorAcceptedBeat =
    secondSequences.filter(sequence => sequence === 101).length === 1;

  requireStorylineFixtureInvariant(
    Buffer.byteLength(exactSerialized, 'utf8')
      === BACKSTAGE_STORYLINE_MAX_BYTES
    && firstAncientBeatRetained
    && firstAcceptedBeatIncluded
    && secondAcceptedBeatIncluded
    && freshReadObservedPriorAcceptedBeat
    && transactionFixture.phases.length
      === STORYLINE_TRANSACTION_PHASES.length * 2,
    'PREVIEW_BACKSTAGE_STORYLINE_LIFECYCLE_INVALID'
  );

  return {
    statusCode: 200,
    payload: {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: true,
      fixture,
      durablePersistenceAttempted: false,
      postValidationBoundaryReached: true,
      protectedEffectsEnabled: false,
      schemaVersion: 1,
      transactionComponentExecuted: true,
      validationCompleted: true,
      validationCode: 'VALID',
      lifecycle: {
        exactBytes: BACKSTAGE_STORYLINE_MAX_BYTES,
        finalResponseSequences,
        firstAcceptedBeatIncluded,
        firstAncientBeatRetained,
        firstNewestSequence: firstSequences.at(-1),
        firstOldestSequence: firstSequences[0],
        firstResponseFirstSequence: firstResponseSequences[0],
        firstResponseLastSequence: firstResponseSequences.at(-1),
        freshReadObservedPriorAcceptedBeat,
        mutationCount: 2,
        queryPhaseCount: transactionFixture.phases.length,
        responseCount: secondResponse.length,
        responseLimit: BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS,
        retainedCount: secondMutation.retainedBeats.length,
        retentionLimit: BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
        secondAcceptedBeatIncluded,
        secondNewestSequence: secondSequences.at(-1),
        secondOldestSequence: secondSequences[0],
        transactionPhaseOrderVerified: true,
      },
    },
  };
}

async function runPhaseOneUniverseBindingFixture(
  fixture: string
): Promise<SyntheticStorylineResult> {
  const action = resolveBackstageGptAction('trackStoryline');
  requireStorylineFixtureInvariant(
    action !== null && isBackstageMutationAction(action),
    'PREVIEW_BACKSTAGE_PHASE_ONE_ACTION_INVALID'
  );

  const alphaUniverseId = 'preview-alpha';
  const betaUniverseId = 'preview-beta';
  const confirmationBeat = parseBackstageStorylinePayload({ sequence: 303 });
  const alphaConfirmationInput = buildBackstageMutationConfirmationFingerprintBody(
    action,
    { universeId: alphaUniverseId, beat: confirmationBeat }
  );
  const betaConfirmationInput = buildBackstageMutationConfirmationFingerprintBody(
    action,
    { universeId: betaUniverseId, beat: confirmationBeat }
  );
  const confirmationFingerprintInputUniverseBound =
    JSON.stringify(alphaConfirmationInput) !== JSON.stringify(betaConfirmationInput);

  const alphaTransaction = createStorylineTransactionFixture(
    [parseBackstageStorylinePayload({ sequence: 1 })],
    alphaUniverseId
  );
  const betaTransaction = createStorylineTransactionFixture(
    [parseBackstageStorylinePayload({ sequence: 2 })],
    betaUniverseId
  );
  const [alphaMutation, betaMutation] = await Promise.all([
    applyBackstageStorylineMutation(
      alphaTransaction.client,
      JSON.stringify(parseBackstageStorylinePayload({ sequence: 101 })),
      alphaUniverseId
    ),
    applyBackstageStorylineMutation(
      betaTransaction.client,
      JSON.stringify(parseBackstageStorylinePayload({ sequence: 202 })),
      betaUniverseId
    ),
  ]);
  const alphaSequences = alphaMutation.retainedBeats.map(storylineSequence);
  const betaSequences = betaMutation.retainedBeats.map(storylineSequence);
  const crossUniverseLeakageObserved =
    alphaSequences.includes(2)
    || alphaSequences.includes(202)
    || betaSequences.includes(1)
    || betaSequences.includes(101);

  requireStorylineFixtureInvariant(
    action === 'trackStoryline'
    && confirmationFingerprintInputUniverseBound
    && !crossUniverseLeakageObserved
    && alphaSequences.length === 2
    && alphaSequences[0] === 1
    && alphaSequences[1] === 101
    && betaSequences.length === 2
    && betaSequences[0] === 2
    && betaSequences[1] === 202
    && alphaTransaction.phases.length === STORYLINE_TRANSACTION_PHASES.length
    && betaTransaction.phases.length === STORYLINE_TRANSACTION_PHASES.length,
    'PREVIEW_BACKSTAGE_PHASE_ONE_UNIVERSE_BINDING_INVALID'
  );

  return {
    statusCode: 200,
    payload: {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: true,
      fixture,
      durablePersistenceAttempted: false,
      postValidationBoundaryReached: true,
      protectedEffectsEnabled: false,
      schemaVersion: 1,
      transactionComponentExecuted: true,
      validationCompleted: true,
      validationCode: 'VALID',
      phaseOne: {
        action,
        canonicalRoute: `/gpt/${BACKSTAGE_MODULE_ROUTE}`,
        confirmationFingerprintInputUniverseBound,
        confirmationTokenIssued: false,
        crossUniverseLeakageObserved,
        queryPhaseCount:
          alphaTransaction.phases.length + betaTransaction.phases.length,
        queryUniverseRoutingVerified: true,
        universes: [
          { universeId: alphaUniverseId, retainedSequences: alphaSequences },
          { universeId: betaUniverseId, retainedSequences: betaSequences },
        ],
      },
    },
  };
}

function runStorylinePayloadOverFixture(
  fixture: string
): SyntheticStorylineResult {
  try {
    parseBackstageStorylinePayload(
      buildStorylineBeatAtSerializedBytes(
        101,
        BACKSTAGE_STORYLINE_MAX_BYTES + 1
      )
    );
  } catch (error) {
    if (!isBackstageStorylineValidationError(error)) {
      throw error;
    }
    return {
      statusCode: 400,
      payload: {
        accepted: false,
        confirmationAttempted: false,
        databaseBoundaryReached: false,
        effectsBoundaryReached: false,
        eligibleForConfirmation: false,
        fixture,
        durablePersistenceAttempted: false,
        postValidationBoundaryReached: false,
        protectedEffectsEnabled: false,
        schemaVersion: 1,
        transactionComponentExecuted: false,
        validationCompleted: true,
        validationCode: error.code,
      },
    };
  }
  throw new Error('PREVIEW_BACKSTAGE_STORYLINE_OVER_LIMIT_ACCEPTED');
}

async function runStorylineFixture(
  fixture: string
): Promise<SyntheticStorylineResult> {
  const fixtures = NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.fixtures;
  switch (fixture) {
    case fixtures.lifecycleExact:
      return runStorylineLifecycleFixture(fixture);
    case fixtures.phaseOneUniverseBinding:
      return runPhaseOneUniverseBindingFixture(fixture);
    case fixtures.payloadOver:
      return runStorylinePayloadOverFixture(fixture);
    default:
      throw new Error('PREVIEW_BACKSTAGE_STORYLINE_FIXTURE_INVALID');
  }
}

interface SyntheticHrcResult {
  fidelity: number;
  resilience: number;
  verdict: string;
}

async function runBackstageRouteBudgetFixture(
  fixture: string
): Promise<Record<string, unknown>> {
  if (!isBackstageGptRoute(BACKSTAGE_MODULE_ROUTE)) {
    throw new Error('PREVIEW_BACKSTAGE_CANONICAL_ROUTE_POLICY_INVALID');
  }
  const routeTimeoutMs = resolveGptRouteHardTimeoutMs({
    minimumMsOverride: BACKSTAGE_ROUTE_TIMEOUT_MINIMUM_MS,
  });
  const generationStageTimeoutMs = resolveBackstageGenerationStageTimeoutMs(
    BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS
  );
  const trinityRunOptions = buildBackstageBookerTrinityRunOptions({
    model: 'native-pr-preview-synthetic',
    tokenLimit: 512,
    userIntentPrompt: 'sealed synthetic provider delay',
    modelStageTimeoutMs: generationStageTimeoutMs,
  });
  if (
    trinityRunOptions.answerMode !== 'direct'
    || trinityRunOptions.internalMode !== false
    || trinityRunOptions.strictUserVisibleOutput !== true
    || trinityRunOptions.directAnswerModelOverride
      !== 'native-pr-preview-synthetic'
    || trinityRunOptions.directAnswerTokenLimitOverride !== 512
    || trinityRunOptions.directAnswerTokenCapOverride
      !== BACKSTAGE_GENERATION_TOKEN_LIMIT_MAX
    || trinityRunOptions.directAnswerUserIntentPrompt
      !== 'sealed synthetic provider delay'
    || trinityRunOptions.modelStageTimeoutMs !== generationStageTimeoutMs
  ) {
    throw new Error('PREVIEW_BACKSTAGE_TRINITY_RUN_OPTIONS_INVALID');
  }
  let providerCompleted = false;

  await runWithRequestAbortTimeout(
    {
      timeoutMs: routeTimeoutMs,
      abortMessage: 'Synthetic Backstage route budget elapsed.',
    },
    async () => {
      const routeContext = getRequestAbortContext();
      if (routeContext?.timeoutMs !== routeTimeoutMs) {
        throw new Error('PREVIEW_BACKSTAGE_ROUTE_CONTEXT_INVALID');
      }
      await runWithRequestAbortTimeout(
        {
          timeoutMs: trinityRunOptions.modelStageTimeoutMs,
          parentSignal: routeContext.signal,
          abortMessage: 'Synthetic Backstage provider stage elapsed.',
        },
        async () => {
          const generationContext = getRequestAbortContext();
          if (
            generationContext?.timeoutMs
            !== trinityRunOptions.modelStageTimeoutMs
          ) {
            throw new Error('PREVIEW_BACKSTAGE_GENERATION_CONTEXT_INVALID');
          }
          await delay(BACKSTAGE_SYNTHETIC_PROVIDER_DELAY_MS, undefined, {
            signal: generationContext.signal,
          });
          providerCompleted = true;
        }
      );
    }
  );

  if (!providerCompleted) {
    throw new Error('PREVIEW_BACKSTAGE_PROVIDER_FIXTURE_INCOMPLETE');
  }

  return {
    accepted: true,
    cacheBoundaryReached: false,
    canonicalRouteRecognized: true,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    externalNetworkAttempted: false,
    fixture,
    generationStageTimeoutMs,
    genericRouteBoundaryMs: GPT_ROUTE_HARD_TIMEOUT_BOUNDS.defaultMs,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    syntheticProviderCompleted: true,
    routeTimeoutMs,
    schemaVersion: 1,
    syntheticProviderDelayMs: BACKSTAGE_SYNTHETIC_PROVIDER_DELAY_MS,
    trinityRunOptions: {
      answerMode: trinityRunOptions.answerMode,
      modelStageTimeoutMs: trinityRunOptions.modelStageTimeoutMs,
      strictUserVisibleOutput: trinityRunOptions.strictUserVisibleOutput,
    },
  };
}

async function runBackstageHrcRetryCacheFixture(
  fixture: string
): Promise<Record<string, unknown>> {
  const values = new Map<string, SyntheticHrcResult>();
  let evaluationCalls = 0;
  let cacheWrites = 0;
  const cacheKey = 'sealed-backstage-hrc-result';
  const cache = {
    get(key: string): SyntheticHrcResult | null {
      return values.get(key) ?? null;
    },
    set(key: string, value: SyntheticHrcResult): void {
      cacheWrites += 1;
      values.set(key, value);
    },
  };
  const fallback: SyntheticHrcResult = {
    fidelity: 0,
    resilience: 0,
    verdict: 'Synthetic HRC timeout fallback',
  };
  const success: SyntheticHrcResult = {
    fidelity: 0.98,
    resilience: 0.97,
    verdict: 'Synthetic HRC retry succeeded',
  };
  const evaluate = async (): Promise<SyntheticHrcResult> => {
    evaluationCalls += 1;
    if (evaluationCalls === 1) {
      let evaluationSignal: AbortSignal | undefined;
      try {
        await runWithRequestAbortTimeout(
          {
            timeoutMs: BACKSTAGE_SYNTHETIC_HRC_TIMEOUT_MS,
            abortMessage: 'Synthetic HRC evaluation timed out.',
          },
          async () => {
            const context = getRequestAbortContext();
            if (!context) {
              throw new Error('PREVIEW_BACKSTAGE_HRC_CONTEXT_MISSING');
            }
            evaluationSignal = context.signal;
            await delay(BACKSTAGE_SYNTHETIC_HRC_DELAY_MS, undefined, {
              signal: context.signal,
            });
          }
        );
      } catch (error) {
        return markHRCResultNonCacheableForAbort(fallback, {
          signal: evaluationSignal,
          error,
        });
      }
      throw new Error('PREVIEW_BACKSTAGE_HRC_TIMEOUT_NOT_OBSERVED');
    }
    return success;
  };
  const run = () => runCachedHrcEvaluation({
    cache,
    cacheKey,
    evaluate,
    fallback,
  });

  const first = await run();
  const firstCacheable = isHRCResultCacheable(first);
  const second = await run();
  const third = await run();
  if (
    first !== fallback
    || firstCacheable
    || second !== success
    || third !== success
    || evaluationCalls !== 2
    || cacheWrites !== 1
  ) {
    throw new Error('PREVIEW_BACKSTAGE_HRC_CACHE_POLICY_INVALID');
  }

  return {
    accepted: true,
    cacheBoundaryReached: true,
    cacheWrites,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    evaluationCalls,
    externalNetworkAttempted: false,
    fixture,
    hrcEvaluationTimeoutMs: BACKSTAGE_HRC_EVALUATION_TIMEOUT_MS,
    first: {
      cacheable: firstCacheable,
      verdict: first.verdict,
    },
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    second: {
      cacheable: isHRCResultCacheable(second),
      verdict: second.verdict,
    },
    syntheticTimeoutMs: BACKSTAGE_SYNTHETIC_HRC_TIMEOUT_MS,
    thirdServedFromCache: third === second,
  };
}

async function runBackstageGenerationFixture(
  fixture: string
): Promise<Record<string, unknown>> {
  const fixtures = NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT.fixtures;
  switch (fixture) {
    case fixtures.routeBudget:
      return runBackstageRouteBudgetFixture(fixture);
    case fixtures.hrcRetryCache:
      return runBackstageHrcRetryCacheFixture(fixture);
    default:
      throw new Error('PREVIEW_BACKSTAGE_GENERATION_FIXTURE_INVALID');
  }
}

function cloneJob(job: GenericJobData): GenericJobData {
  const cloned = structuredClone(job);
  for (const [key, value] of Object.entries(job)) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      (cloned as unknown as Record<string, unknown>)[key] =
        new Date((value as Date).getTime());
    }
  }
  return cloned;
}

function buildFixture(
  id: string,
  status: GenericJobData['status'],
  overrides: Partial<GenericJobData> = {}
): GenericJobData {
  return Object.freeze({
    id,
    worker_id: 'native-pr-preview-fixture',
    job_type: 'gpt',
    status,
    claim_generation: '0',
    input: {
      requestPath: '/gpt/arcanos-preview',
      executionModeReason: 'native_pr_preview_fixture',
    },
    output: null,
    error_message: null,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
    completed_at: undefined,
    cancel_requested_at: null,
    cancel_reason: null,
    ...overrides,
  }) as GenericJobData;
}

function createSealedFixtureRepository() {
  const fixtures = new Map<string, GenericJobData>([
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
        'completed',
        {
          output: {
            ok: true,
            result: { answer: 'synthetic preview result' },
          },
          completed_at: FIXTURE_COMPLETED_TIMESTAMP,
          updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        }
      ),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.failed,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.failed,
        'failed',
        {
          error_message: 'Synthetic preview failure.',
          completed_at: FIXTURE_COMPLETED_TIMESTAMP,
          updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        }
      ),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable,
      buildFixture(NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable, 'pending'),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
        'completed',
        {
          output: {
            ok: true,
            result: { answer: 'synthetic terminal result' },
          },
          completed_at: FIXTURE_COMPLETED_TIMESTAMP,
          updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        }
      ),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable,
        'pending'
      ),
    ],
  ]);

  return Object.freeze({
    async getJobById(jobId: string): Promise<GenericJobData | null> {
      if (jobId === NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable) {
        throw new NativePrPreviewRepositoryUnavailableError();
      }
      const fixture = fixtures.get(jobId);
      return fixture ? cloneJob(fixture) : null;
    },
    async requestJobCancellation(jobId: string) {
      if (
        jobId === NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable
        || jobId ===
          NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable
      ) {
        throw new NativePrPreviewRepositoryUnavailableError();
      }
      const fixture = fixtures.get(jobId);
      if (!fixture) {
        return { outcome: 'not_found' as const, job: null };
      }
      if (
        fixture.status === 'completed'
        || fixture.status === 'failed'
        || fixture.status === 'cancelled'
        || fixture.status === 'expired'
      ) {
        return {
          outcome: 'already_terminal' as const,
          job: cloneJob(fixture),
        };
      }

      const cancelled = cloneJob({
        ...fixture,
        status: 'cancelled',
        updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        completed_at: FIXTURE_COMPLETED_TIMESTAMP,
        cancel_requested_at: FIXTURE_COMPLETED_TIMESTAMP,
        cancel_reason: 'Synthetic preview cancellation.',
      });
      return {
        outcome: 'cancelled' as const,
        job: cancelled,
      };
    },
  });
}

function validateIdentity(identity: NativePrPreviewIdentity): void {
  if (
    !Number.isSafeInteger(identity.prNumber)
    || identity.prNumber < 1
    || !SAFE_SOURCE_COMMIT_PATTERN.test(identity.sourceCommit)
  ) {
    throw new Error('PREVIEW_APPLICATION_IDENTITY_INVALID');
  }
}

function isCredentialCarrierPresent(request: express.Request): boolean {
  return Object.keys(request.headers).some((rawHeaderName) => {
    const headerName = rawHeaderName.toLowerCase();
    return FORBIDDEN_HEADER_NAMES.has(headerName)
      || SENSITIVE_HEADER_SEGMENT_PATTERN.test(headerName)
      || headerName.startsWith('x-arcanos-')
      || headerName.startsWith('x-openai-');
  });
}

function isPreviewRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactPreviewKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[]
): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => expectedKeys.includes(key));
}

function normalizePreviewCorrelationId(
  value: string | undefined,
  fallback: string
): string {
  const trimmed = value?.trim() ?? '';
  return SAFE_CORRELATION_ID_PATTERN.test(trimmed) ? trimmed : fallback;
}

function applyPreviewResponseHeaders(
  request: express.Request,
  response: express.Response
): void {
  const requestId = normalizePreviewCorrelationId(
    request.header('x-request-id'),
    PREVIEW_DEFAULT_REQUEST_ID
  );
  const traceId = normalizePreviewCorrelationId(
    request.header('x-trace-id'),
    requestId
  );
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    PREVIEW_SECURITY_HEADERS['Content-Security-Policy']
  );
  response.setHeader(
    'Cross-Origin-Resource-Policy',
    PREVIEW_SECURITY_HEADERS['Cross-Origin-Resource-Policy']
  );
  response.setHeader(
    'Permissions-Policy',
    PREVIEW_SECURITY_HEADERS['Permissions-Policy']
  );
  response.setHeader(
    'Referrer-Policy',
    PREVIEW_SECURITY_HEADERS['Referrer-Policy']
  );
  response.setHeader(
    'Strict-Transport-Security',
    PREVIEW_SECURITY_HEADERS['Strict-Transport-Security']
  );
  response.setHeader(
    'X-Content-Type-Options',
    PREVIEW_SECURITY_HEADERS['X-Content-Type-Options']
  );
  response.setHeader(
    'X-Frame-Options',
    PREVIEW_SECURITY_HEADERS['X-Frame-Options']
  );
  response.setHeader('X-Request-Id', requestId);
  response.setHeader('X-Trace-Id', traceId);
  (response.locals as Record<string, unknown>).nativePreviewRequestId =
    requestId;
  (response.locals as Record<string, unknown>).nativePreviewTraceId = traceId;
}

function readPreviewCorrelation(response: express.Response): {
  requestId: string;
  traceId: string;
} {
  const locals = response.locals as Record<string, unknown>;
  const requestId = typeof locals.nativePreviewRequestId === 'string'
    ? locals.nativePreviewRequestId
    : PREVIEW_DEFAULT_REQUEST_ID;
  const traceId = typeof locals.nativePreviewTraceId === 'string'
    ? locals.nativePreviewTraceId
    : requestId;
  return { requestId, traceId };
}

function sendPreviewJson(
  request: express.Request,
  response: express.Response,
  payload: Record<string, unknown>,
  statusCode: number,
  maxBytes: number,
  logEvent: string
): void {
  response.setHeader(
    NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name,
    NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value
  );
  sendBoundedJsonResponse(request, response, payload, {
    logEvent,
    maxBytes,
    statusCode,
  });
}

function runSealedGamingCanary(
  body: unknown,
  correlation: { requestId: string; traceId: string }
): { payload: Record<string, unknown>; statusCode: 200 | 400 | 500 | 503 } {
  const dispatch = dispatchPublicGamingRequest(body, 'canary');
  const result = dispatch.ok
    ? executePublicGamingCanary({
        requestId: correlation.requestId,
        traceId: correlation.traceId,
        startedAtMs: 0,
        dependencies: { now: () => 0 },
      })
    : {
        statusCode: 400 as const,
        response: buildPublicGamingCanaryFailure({
          code: 'BAD_REQUEST',
          requestId: correlation.requestId,
          traceId: correlation.traceId,
          durationMs: 0,
        }),
      };
  const guarded = prepareGuardedPublicGamingCanaryResponse({
    response: result.response,
    statusCode: result.statusCode,
    requestId: correlation.requestId,
    traceId: correlation.traceId,
  });
  return {
    payload: guarded.response as unknown as Record<string, unknown>,
    statusCode: guarded.statusCode,
  };
}

function resolveGamingQueryFixture(body: unknown):
  | { kind: 'success'; mode: SyntheticGamingMode }
  | { kind: 'operational' }
  | { kind: 'validation'; code: string; message: string } {
  if (!isPreviewRecord(body) || body.action !== 'query') {
    return {
      kind: 'validation',
      code: isPreviewRecord(body) && body.action !== undefined
        ? 'BAD_REQUEST'
        : 'GPT_ACTION_REQUIRED',
      message: "Gaming requests require action 'query'.",
    };
  }
  if (!isPreviewRecord(body.payload)) {
    return {
      kind: 'validation',
      code: 'BAD_REQUEST',
      message: 'Gaming query requests require a payload object.',
    };
  }
  const payload = body.payload;
  if (!hasExactPreviewKeys(body, ['action', 'payload'])) {
    return {
      kind: 'validation',
      code: 'BAD_REQUEST',
      message: 'Gaming query request exceeds the published field limits.',
    };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'mode')) {
    return {
      kind: 'validation',
      code: 'GAMEPLAY_MODE_REQUIRED',
      message:
        "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
    };
  }
  if (!hasExactPreviewKeys(payload, ['mode', 'game', 'prompt'])) {
    return {
      kind: 'validation',
      code: 'BAD_REQUEST',
      message: 'Gaming query request exceeds the published field limits.',
    };
  }
  if (payload.game !== NATIVE_PR_PREVIEW_GAMING_CONTRACT.game) {
    return {
      kind: 'validation',
      code: 'BAD_REQUEST',
      message: 'The sealed Gaming preview accepts only its fixed game fixture.',
    };
  }
  if (payload.prompt === NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures.operational) {
    return { kind: 'operational' };
  }
  for (const mode of ['guide', 'build', 'meta'] as const) {
    if (
      payload.mode === mode
      && payload.prompt === NATIVE_PR_PREVIEW_GAMING_CONTRACT.fixtures[mode]
    ) {
      return { kind: 'success', mode };
    }
  }
  return {
    kind: 'validation',
    code: 'BAD_REQUEST',
    message: 'The sealed Gaming preview accepts only fixed query fixtures.',
  };
}

function buildGamingQuerySuccess(
  mode: SyntheticGamingMode,
  correlation: { requestId: string; traceId: string }
): Record<string, unknown> {
  return {
    ok: true,
    requestId: correlation.requestId,
    traceId: correlation.traceId,
    result: {
      ok: true,
      route: 'gaming',
      mode,
      data: {
        response: `Sealed preview ${mode} response.`,
        sources: [],
      },
    },
    _route: {
      requestId: correlation.requestId,
      traceId: correlation.traceId,
      gptId: 'arcanos-gaming',
      module: 'ARCANOS:GAMING',
      action: 'query',
      route: 'gaming',
      timestamp: GAMING_SOURCE_CREATED_AT,
    },
  };
}

function buildGamingQueryError(
  code: string,
  message: string,
  route: 'gaming_operational_guard' | 'gaming_validation',
  correlation: { requestId: string; traceId: string }
): Record<string, unknown> {
  return {
    ok: false,
    requestId: correlation.requestId,
    traceId: correlation.traceId,
    gptId: 'arcanos-gaming',
    action: 'query',
    route: '/gpt/:gptId',
    error: { code, message },
    _route: {
      requestId: correlation.requestId,
      traceId: correlation.traceId,
      gptId: 'arcanos-gaming',
      action: 'query',
      route,
      timestamp: GAMING_SOURCE_CREATED_AT,
    },
  };
}

function isExactGamingSourceIngestionBody(
  body: unknown,
  idempotencyKey: string,
  validationFixture = false
): boolean {
  if (!isPreviewRecord(body) || !hasExactPreviewKeys(body, ['action', 'payload'])) {
    return false;
  }
  const payload = body.payload;
  return body.action === 'ingest'
    && isPreviewRecord(payload)
    && hasExactPreviewKeys(
      payload,
      validationFixture
        ? ['game', 'sourceUrls', 'origin', 'idempotencyKey', 'unexpected']
        : ['game', 'sourceUrls', 'origin', 'idempotencyKey']
    )
    && payload.game === NATIVE_PR_PREVIEW_GAMING_CONTRACT.game
    && Array.isArray(payload.sourceUrls)
    && payload.sourceUrls.length === 1
    && payload.sourceUrls[0] === GAMING_SOURCE_CANONICAL_URL
    && payload.origin === 'user_supplied'
    && payload.idempotencyKey === idempotencyKey
    && (
      !validationFixture
      || payload.unexpected === GAMING_SOURCE_VALIDATION_PADDING
    );
}

function isExactGamingSourceRefreshBody(
  body: unknown,
  idempotencyKey: string,
  validationFixture = false
): boolean {
  if (!isPreviewRecord(body) || !hasExactPreviewKeys(body, ['action', 'payload'])) {
    return false;
  }
  const payload = body.payload;
  return body.action === 'refresh'
    && isPreviewRecord(payload)
    && hasExactPreviewKeys(
      payload,
      validationFixture
        ? ['sourceIds', 'idempotencyKey', 'reason', 'unexpected']
        : ['sourceIds', 'idempotencyKey', 'reason']
    )
    && Array.isArray(payload.sourceIds)
    && payload.sourceIds.length === 1
    && payload.sourceIds[0] ===
      NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.sourceId
    && payload.idempotencyKey === idempotencyKey
    && payload.reason === 'user_requested'
    && (!validationFixture || payload.unexpected === true);
}

function buildGamingSourceUnauthorized(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'UNAUTHORIZED_GPT_ACCESS',
      message: 'Missing GPT access bearer token.',
    },
  };
}

function buildGamingSourceValidation(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'GAMING_SOURCE_VALIDATION_ERROR',
      message: 'Invalid gaming-source request.',
    },
  };
}

function buildGamingSourceParserValidation(
  correlation: { requestId: string; traceId: string }
): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'GAMING_SOURCE_VALIDATION_ERROR',
      message: 'The Gaming source request is invalid.',
    },
    requestId: correlation.requestId,
    traceId: correlation.traceId,
  };
}

function buildGamingSourceUnsafe(
  correlation: { requestId: string; traceId: string }
): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'UNSAFE_EXECUTION_DISABLED',
      message:
        'Gaming-source mutations are temporarily unavailable because runtime integrity checks did not pass.',
    },
    requestId: correlation.requestId,
    traceId: correlation.traceId,
  };
}

function buildGamingSourceOutage(statusRequest = false): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'GAMING_SOURCE_JOBS_UNAVAILABLE',
      message: statusRequest
        ? 'Gaming-source ingestion status is unavailable.'
        : 'Durable gaming-source ingestion is unavailable.',
    },
  };
}

function buildGamingSourceQueued(
  action: 'ingest' | 'refresh',
  ingestionId: string,
  deduplicated: boolean,
  correlation: { requestId: string; traceId: string }
): Record<string, unknown> {
  return {
    ok: true,
    action,
    ingestionId,
    status: 'queued',
    deduplicated,
    statusUrl:
      `${NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionPath}/${ingestionId}`,
    sources: [
      {
        submittedIndex: 0,
        status: 'queued',
        canonicalUrl: GAMING_SOURCE_CANONICAL_URL,
        ...(action === 'refresh'
          ? { sourceId: NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.sourceId }
          : {}),
        recordsCreated: 0,
        recordsUpdated: 0,
      },
    ],
    createdAt: GAMING_SOURCE_CREATED_AT,
    requestId: correlation.requestId,
    traceId: correlation.traceId,
  };
}

function buildGamingSourceStatus(
  ingestionId: string,
  status: 'queued' | 'running' | 'completed',
  correlation: { requestId: string; traceId: string }
): Record<string, unknown> {
  const completed = status === 'completed';
  const running = status === 'running';
  return {
    ok: true,
    action: 'status',
    ingestionId,
    status,
    counts: {
      total: 1,
      queued: status === 'queued' ? 1 : 0,
      succeeded: completed ? 1 : 0,
      rejected: 0,
      failed: 0,
      recordsCreated: completed ? 1 : 0,
      recordsUpdated: 0,
    },
    sources: [
      completed
        ? {
            submittedIndex: 0,
            status: 'stored',
            canonicalUrl: GAMING_SOURCE_CANONICAL_URL,
            sourceId: NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.sourceId,
            sourceType: 'wiki',
            recordsCreated: 1,
            recordsUpdated: 0,
            fetchedAt: GAMING_SOURCE_COMPLETED_AT,
            completedAt: GAMING_SOURCE_COMPLETED_AT,
            warnings: [],
          }
        : {
            submittedIndex: 0,
            status: running ? 'running' : 'queued',
            canonicalUrl: GAMING_SOURCE_CANONICAL_URL,
            recordsCreated: 0,
            recordsUpdated: 0,
          },
    ],
    createdAt: GAMING_SOURCE_CREATED_AT,
    updatedAt: completed
      ? GAMING_SOURCE_COMPLETED_AT
      : running
        ? GAMING_SOURCE_RUNNING_AT
        : GAMING_SOURCE_CREATED_AT,
    ...(completed ? { completedAt: GAMING_SOURCE_COMPLETED_AT } : {}),
    requestId: correlation.requestId,
    traceId: correlation.traceId,
  };
}

function sendGamingSourceResponse(
  request: express.Request,
  response: express.Response,
  statusCode: number,
  payload: Record<string, unknown>,
  logEvent: string
): void {
  response.setHeader('Pragma', 'no-cache');
  sendPreviewJson(
    request,
    response,
    payload,
    statusCode,
    MAX_GAMING_SOURCE_RESPONSE_BYTES,
    logEvent
  );
}

function stripSinglePreviewTrailingSlash(rawPath: string): string | null {
  if (rawPath.length <= 1 || !rawPath.endsWith('/')) {
    return rawPath;
  }
  return rawPath.endsWith('//') ? null : rawPath.slice(0, -1);
}

function isCanonicalPreviewGamingStatusId(rawId: string): boolean {
  if (/%2f/iu.test(rawId)) {
    return false;
  }
  let decodedId: string;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    return false;
  }
  return decodedId.length > 0
    && decodedId.length <= 128
    && !decodedId.includes('%')
    && !decodedId.includes('/')
    && !decodedId.includes('\\')
    && !/[\u0000-\u001F\u007F]/u.test(decodedId);
}

function resolvePreviewGamingSourcePath(
  rawPath: string
): PreviewGamingSourceResolution | null {
  const normalizedRawPath = stripSinglePreviewTrailingSlash(rawPath);
  if (!normalizedRawPath) {
    return null;
  }
  const normalizedLowerPath = normalizedRawPath.toLowerCase();
  const ingestionPath =
    NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionPath;
  const refreshPath = NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.refreshPath;
  if (normalizedLowerPath === ingestionPath) {
    return { canonical: true, kind: 'ingestion' };
  }
  if (normalizedLowerPath === refreshPath) {
    return { canonical: true, kind: 'refresh' };
  }
  const statusPrefix =
    NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.statusPathPrefix;
  if (!normalizedLowerPath.startsWith(statusPrefix)) {
    return null;
  }
  const rawId = normalizedRawPath.slice(statusPrefix.length);
  if (rawId.length === 0 || rawId.includes('/')) {
    return null;
  }
  return {
    canonical: isCanonicalPreviewGamingStatusId(rawId),
    kind: 'status',
  };
}

function countPreviewRawHeaders(
  request: express.Request,
  headerName: string
): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === headerName) {
      count += 1;
    }
  }
  return count;
}

function hasPreviewJsonContentType(request: express.Request): boolean {
  return request.header('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() === 'application/json';
}

function hasUnsupportedPreviewContentEncoding(
  request: express.Request
): boolean {
  const encoding = request.header('content-encoding')?.trim().toLowerCase();
  return encoding !== undefined && encoding.length > 0 && encoding !== 'identity';
}

function resolvePreviewJsonParserStatus(
  error: unknown
): 400 | 413 | 415 | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const parserError = error as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  if (
    parserError.type === 'entity.too.large'
    || parserError.status === 413
    || parserError.statusCode === 413
  ) {
    return 413;
  }
  if (
    parserError.type === 'encoding.unsupported'
    || parserError.status === 415
    || parserError.statusCode === 415
  ) {
    return 415;
  }
  if (
    parserError.type === 'entity.parse.failed'
    || parserError.type === 'entity.verify.failed'
    || parserError.type === 'request.aborted'
    || parserError.type === 'request.size.invalid'
  ) {
    return 400;
  }
  return null;
}

function createSelfHealApprovalExecution(
  overrides: Partial<PredictiveExecutionDisposition> = {}
): PredictiveExecutionDisposition {
  return {
    action: 'heal_worker_runtime',
    attempted: false,
    decisionAction: 'heal_worker_runtime',
    decisionSafeToExecute: true,
    decisionTarget: 'worker_runtime',
    mode: 'recommend_only',
    status: 'skipped',
    target: 'worker_runtime',
    ...overrides,
  };
}

function executeSelfHealApprovalCase(params: {
  execution?: Partial<PredictiveExecutionDisposition>;
  name: string;
  predictiveFallback?: boolean;
  predictiveHealingEnabled?: boolean;
}): Record<string, unknown> {
  const approval = resolvePredictiveReactiveApproval({
    predictiveFallback: params.predictiveFallback ?? false,
    predictiveHealingEnabled: params.predictiveHealingEnabled ?? true,
    execution: createSelfHealApprovalExecution(params.execution),
  });
  const authorization = resolveSelfHealingEffectAuthorization({
    approval,
    debugApprovalApplied: false,
    hasActionPlan: true,
  });
  return {
    name: params.name,
    approvalSource: approval.source,
    allowLegacyReactiveEffects: approval.allowLegacyReactiveEffects,
    ...authorization,
  };
}

function buildSelfHealApprovalFixtureEnvelope(
  fixture: string,
  policy: Record<string, unknown>
): Record<string, unknown> {
  return {
    componentExecuted: true,
    databaseBoundaryReached: false,
    effectsBoundaryReached: false,
    fixture,
    kind: 'predictive_reactive_self_heal_approval_contract',
    memoryBoundaryReached: false,
    outboundNetworkBoundaryReached: false,
    policy,
    protectedEffectsEnabled: false,
    providerBoundaryReached: false,
    schemaVersion: 1,
    workerBoundaryReached: false,
  };
}

function runSelfHealApprovalFixture(fixture: string): Record<string, unknown> {
  const fixtures = NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT.fixtures;
  if (fixture === fixtures.deniedOutcomes) {
    const outcomes = [
      executeSelfHealApprovalCase({
        name: 'authoritative-refusal',
        execution: { status: 'refused' },
      }),
      executeSelfHealApprovalCase({
        name: 'authoritative-recommendation',
      }),
      executeSelfHealApprovalCase({
        name: 'authoritative-dry-run',
        execution: { mode: 'dry_run', status: 'dry_run' },
      }),
      executeSelfHealApprovalCase({
        name: 'deterministic-fallback',
        predictiveFallback: true,
      }),
      executeSelfHealApprovalCase({
        name: 'attempted-failure',
        execution: {
          attempted: true,
          mode: 'auto_execute',
          status: 'failed',
        },
      }),
      executeSelfHealApprovalCase({
        name: 'declined-automatic-actuator',
        execution: { mode: 'auto_execute' },
      }),
    ];
    return buildSelfHealApprovalFixtureEnvelope(fixture, {
      allReactiveEffectsDenied: outcomes.every((outcome) =>
        outcome.allowReactiveAction === false
        && outcome.allowAutomaticController === false
      ),
      caseCount: outcomes.length,
      outcomes,
    });
  }

  if (fixture === fixtures.validCompleted) {
    const outcome = executeSelfHealApprovalCase({
      name: 'valid-completed',
      execution: {
        attempted: true,
        mode: 'auto_execute',
        status: 'executed',
      },
    });
    return buildSelfHealApprovalFixtureEnvelope(fixture, {
      confirmedPredictiveExecution:
        outcome.approvalSource === 'predictive_already_executed',
      outcome,
    });
  }

  if (fixture === fixtures.incoherentCompleted) {
    const outcomes = [
      executeSelfHealApprovalCase({
        name: 'attempt-missing',
        execution: { mode: 'auto_execute', status: 'executed' },
      }),
      executeSelfHealApprovalCase({
        name: 'mode-mismatch',
        execution: { attempted: true, mode: 'dry_run', status: 'executed' },
      }),
      executeSelfHealApprovalCase({
        name: 'action-mismatch',
        execution: {
          action: 'scale_workers_up',
          attempted: true,
          mode: 'auto_execute',
          status: 'executed',
        },
      }),
      executeSelfHealApprovalCase({
        name: 'target-mismatch',
        execution: {
          attempted: true,
          mode: 'auto_execute',
          status: 'executed',
          target: 'worker_runtime:other',
        },
      }),
      executeSelfHealApprovalCase({
        name: 'safety-mismatch',
        execution: {
          attempted: true,
          decisionSafeToExecute: false,
          mode: 'auto_execute',
          status: 'executed',
        },
      }),
      executeSelfHealApprovalCase({
        name: 'decision-action-none',
        execution: {
          action: 'none',
          attempted: true,
          decisionAction: 'none',
          decisionTarget: null,
          mode: 'auto_execute',
          status: 'executed',
          target: null,
        },
      }),
      executeSelfHealApprovalCase({
        name: 'disabled-completed',
        predictiveHealingEnabled: false,
        execution: {
          attempted: true,
          mode: 'auto_execute',
          status: 'executed',
        },
      }),
    ];
    return buildSelfHealApprovalFixtureEnvelope(fixture, {
      allCompletedStatesRejected: outcomes.every((outcome) =>
        outcome.approvalSource === 'predictive_state_invalid'
        && outcome.allowReactiveAction === false
        && outcome.allowAutomaticController === false
      ),
      caseCount: outcomes.length,
      outcomes,
    });
  }

  if (fixture === fixtures.disabledLegacy) {
    const outcome = executeSelfHealApprovalCase({
      name: 'disabled-legacy',
      predictiveHealingEnabled: false,
    });
    return buildSelfHealApprovalFixtureEnvelope(fixture, {
      legacyReactivePolicyPreserved:
        outcome.approvalSource === 'predictive_disabled'
        && outcome.allowReactiveAction === true
        && outcome.allowAutomaticController === true,
      outcome,
    });
  }

  if (fixture === fixtures.manualIndependence) {
    const common = {
      actionPresent: false,
      allowAutomaticController: false,
      automaticControllerConfigured: true,
      hasControllerInput: true,
    } as const;
    const automaticControllerRunAllowed = shouldRunSelfHealingController({
      ...common,
      trigger: 'interval',
    });
    const manualControllerRunAllowed = shouldRunSelfHealingController({
      ...common,
      trigger: 'manual',
    });
    return buildSelfHealApprovalFixtureEnvelope(fixture, {
      automaticControllerRunAllowed,
      manualAuthorityIndependent:
        manualControllerRunAllowed && !automaticControllerRunAllowed,
      manualControllerRunAllowed,
    });
  }

  if (fixture === fixtures.productionDebugDenial) {
    const debugInput = {
      debugOverrideConsumed: false,
      debugOverrideRequested: true,
      hasActionPlan: true,
    } as const;
    const developmentDebugOverrideEligible =
      isSelfHealingDebugOverrideEligible({
        ...debugInput,
        nodeEnvironment: 'development',
      });
    const productionDebugOverrideEligible =
      isSelfHealingDebugOverrideEligible({
        ...debugInput,
        nodeEnvironment: 'production',
      });
    return buildSelfHealApprovalFixtureEnvelope(fixture, {
      developmentDebugOverrideEligible,
      productionDebugDenied:
        developmentDebugOverrideEligible && !productionDebugOverrideEligible,
      productionDebugOverrideEligible,
    });
  }

  throw new Error('PREVIEW_SELF_HEAL_APPROVAL_FIXTURE_INVALID');
}

function buildAllowedRouteKeys(): Set<string> {
  const allowed = new Set([
    'GET /health',
    'HEAD /health',
    'GET /healthz',
    'HEAD /healthz',
    'GET /readyz',
    'HEAD /readyz',
    `POST ${NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path}`,
    `POST ${NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT.path}`,
    `POST ${NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path}`,
    `POST ${NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path}`,
    `POST ${NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT.path}`,
    `POST ${NATIVE_PR_PREVIEW_GAMING_CONTRACT.canaryPath}`,
    `POST ${NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath}`,
    `POST ${NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionPath}`,
    `POST ${NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.refreshPath}`,
    `OPTIONS ${NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionPath}`,
    'GET /jobs/not-a-uuid',
    'GET /jobs/not-a-uuid/result',
    'POST /jobs/not-a-uuid/cancel',
  ]);
  for (const jobId of Object.values(NATIVE_PR_PREVIEW_FIXTURE_IDS)) {
    allowed.add(`GET /jobs/${jobId}`);
    allowed.add(`GET /jobs/${jobId}/result`);
  }
  for (const jobId of [
    NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.missing,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.authUnavailable,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.unauthorized,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable,
  ]) {
    allowed.add(`POST /jobs/${jobId}/cancel`);
  }
  for (
    const ingestionId
    of Object.values(
      NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionIds
    )
  ) {
    allowed.add(
      `GET ${NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.statusPathPrefix}${ingestionId}`
    );
  }
  allowed.add(
    `GET ${NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.statusPathPrefix}not-a-uuid`
  );
  return allowed;
}

function sendFixedNotFound(
  request: express.Request,
  response: express.Response
): void {
  response.status(404);
  response.type('text/plain');
  response.send(request.method === 'HEAD' ? undefined : 'not found');
}

export function createNativePrPreviewReadinessState():
NativePrPreviewReadinessState {
  return {
    applicationImported: false,
    draining: false,
    fixturesSealed: false,
    ready: false,
  };
}

export function createNativePrPreviewApplication(
  options: NativePrPreviewApplicationOptions
): express.Express {
  validateIdentity(options.identity);
  const app = express();
  const allowedRouteKeys = buildAllowedRouteKeys();
  const fixtureRepository = createSealedFixtureRepository();
  const jsonBodyParser = express.json({
    // The pre-parser allowlist retains the 4 KiB ceiling everywhere else.
    // Gaming-source fixtures mirror the production route's 16 KiB ceiling.
    inflate: false,
    limit: MAX_GAMING_SOURCE_REQUEST_BYTES,
    strict: true,
    type: 'application/json',
  });

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    applyPreviewResponseHeaders(request, response);
    const rawUrl = request.url ?? '';
    const rawPath = rawUrl.split('?', 1)[0] ?? '';
    const routeKey = `${request.method ?? ''} ${rawPath}`;
    const gamingSourceResolution = resolvePreviewGamingSourcePath(rawPath);
    const gamingSourcePath = gamingSourceResolution !== null;
    const sourceFixture = request.header(
      NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtureHeader
    );
    const contentLength = request.header('content-length');
    const parsedContentLength = contentLength === undefined
      ? 0
      : Number.parseInt(contentLength, 10);
    const isPost = request.method === 'POST';
    const contentType = request.header('content-type') ?? '';

    if (
      rawUrl.includes('?')
      || (rawPath.includes('%') && !gamingSourcePath)
      || (!gamingSourcePath && !allowedRouteKeys.has(routeKey))
      || isCredentialCarrierPresent(request)
      || (
        sourceFixture !== undefined
        && (
          !gamingSourcePath
          || !GAMING_SOURCE_FIXTURE_NAMES.has(sourceFixture)
        )
      )
    ) {
      sendFixedNotFound(request, response);
      return;
    }
    if (
      rawPath === NATIVE_PR_PREVIEW_GAMING_CONTRACT.canaryPath
      || rawPath === NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath
      || rawPath === NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT.path
      || rawPath === NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT.path
      || gamingSourcePath
    ) {
      response.setHeader(
        NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.name,
        NATIVE_PR_PREVIEW_SYNTHETIC_RESPONSE_HEADER.value
      );
    }
    if (gamingSourcePath) {
      response.setHeader('Pragma', 'no-cache');
    }
    const correlation = readPreviewCorrelation(response);
    if (sourceFixture === undefined && gamingSourcePath) {
      sendGamingSourceResponse(
        request,
        response,
        401,
        buildGamingSourceUnauthorized(),
        'native_pr_preview.gaming_source_unauthorized'
      );
      return;
    }
    if (gamingSourceResolution?.canonical === false) {
      sendGamingSourceResponse(
        request,
        response,
        400,
        buildGamingSourceParserValidation(correlation),
        'native_pr_preview.gaming_status_non_canonical'
      );
      return;
    }
    if (gamingSourcePath) {
      const invalidContentLength = contentLength !== undefined
        && !CONTENT_LENGTH_PATTERN.test(contentLength);
      if (
        invalidContentLength
        || !Number.isSafeInteger(parsedContentLength)
        || parsedContentLength < 0
      ) {
        sendGamingSourceResponse(
          request,
          response,
          400,
          buildGamingSourceParserValidation(correlation),
          'native_pr_preview.gaming_source_content_length_invalid'
        );
        return;
      }

      if (request.method === 'GET') {
        if (
          request.header('transfer-encoding') !== undefined
          || parsedContentLength !== 0
        ) {
          sendGamingSourceResponse(
            request,
            response,
            400,
            buildGamingSourceParserValidation(correlation),
            'native_pr_preview.gaming_source_read_body_rejected'
          );
          return;
        }
        next();
        return;
      }

      if (request.method === 'POST') {
        if (
          request.header('transfer-encoding') !== undefined
          || parsedContentLength < 1
        ) {
          sendGamingSourceResponse(
            request,
            response,
            400,
            buildGamingSourceParserValidation(correlation),
            'native_pr_preview.gaming_source_body_required'
          );
          return;
        }
        if (parsedContentLength > MAX_GAMING_SOURCE_REQUEST_BYTES) {
          sendGamingSourceResponse(
            request,
            response,
            413,
            buildGamingSourceParserValidation(correlation),
            'native_pr_preview.gaming_source_body_too_large'
          );
          return;
        }
        if (
          hasUnsupportedPreviewContentEncoding(request)
          || countPreviewRawHeaders(request, 'content-type') > 1
          || !hasPreviewJsonContentType(request)
        ) {
          sendGamingSourceResponse(
            request,
            response,
            415,
            buildGamingSourceParserValidation(correlation),
            'native_pr_preview.gaming_source_media_type_rejected'
          );
          return;
        }
        next();
        return;
      }

      if (
        request.header('transfer-encoding') !== undefined
        || parsedContentLength !== 0
      ) {
        sendGamingSourceResponse(
          request,
          response,
          400,
          buildGamingSourceParserValidation(correlation),
          'native_pr_preview.gaming_source_method_body_rejected'
        );
        return;
      }
      next();
      return;
    }
    if (
      request.header('content-encoding') !== undefined
      || request.header('transfer-encoding') !== undefined
      || (
        contentLength !== undefined
        && !CONTENT_LENGTH_PATTERN.test(contentLength)
      )
      || !Number.isSafeInteger(parsedContentLength)
      || parsedContentLength < 0
      || parsedContentLength > MAX_REQUEST_BYTES
      || (!isPost && parsedContentLength !== 0)
      || (
        isPost
        && (
          parsedContentLength < 1
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
            contentType
          )
        )
      )
    ) {
      sendFixedNotFound(request, response);
      return;
    }
    next();
  });

  app.get(['/health', '/healthz'], (_request, response) => {
    response.type('text/plain').send('ok');
  });

  app.get('/readyz', (_request, response) => {
    const ready =
      options.readinessState.ready
      && options.readinessState.applicationImported
      && options.readinessState.fixturesSealed
      && !options.readinessState.draining;
    response.status(ready ? 200 : 503).json({
      applicationImported: options.readinessState.applicationImported,
      fixturesSealed: options.readinessState.fixturesSealed,
      mode: NATIVE_PR_PREVIEW_MODE,
      prNumber: options.identity.prNumber,
      processKind: 'web',
      protectedEffectsEnabled: false,
      protectsMaliciousPr: false,
      ready,
      requiresPlatformSecretIsolationForUntrustedCode: true,
      sourceCommit: options.identity.sourceCommit,
      trustScope: NATIVE_PR_PREVIEW_TRUST_SCOPE,
    });
  });

  app.use((request, response, next) => {
    if (request.method !== 'POST') {
      next();
      return;
    }
    jsonBodyParser(request, response, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      const rawPath = (request.url ?? '').split('?', 1)[0] ?? '';
      const fixture = request.header(
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtureHeader
      );
      const statusCode = resolvePreviewJsonParserStatus(error);
      if (
        statusCode !== null
        && resolvePreviewGamingSourcePath(rawPath) !== null
        && fixture !== undefined
        && GAMING_SOURCE_FIXTURE_NAMES.has(fixture)
      ) {
        sendGamingSourceResponse(
          request,
          response,
          statusCode,
          buildGamingSourceParserValidation(readPreviewCorrelation(response)),
          'native_pr_preview.gaming_source_parser_rejected'
        );
        return;
      }
      next(error);
    });
  });

  app.post(
    NATIVE_PR_PREVIEW_GAMING_CONTRACT.canaryPath,
    (request, response) => {
      const correlation = readPreviewCorrelation(response);
      const result = runSealedGamingCanary(request.body, correlation);
      sendPreviewJson(
        request,
        response,
        result.payload,
        result.statusCode,
        MAX_GAMING_CANARY_RESPONSE_BYTES,
        result.statusCode === 200
          ? 'native_pr_preview.gaming_canary'
          : 'native_pr_preview.gaming_canary_invalid'
      );
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_GAMING_CONTRACT.queryPath,
    (request, response) => {
      const correlation = readPreviewCorrelation(response);
      const fixture = resolveGamingQueryFixture(request.body);
      if (fixture.kind === 'success') {
        sendPreviewJson(
          request,
          response,
          buildGamingQuerySuccess(fixture.mode, correlation),
          200,
          MAX_GAMING_QUERY_RESPONSE_BYTES,
          'native_pr_preview.gaming_query'
        );
        return;
      }
      if (fixture.kind === 'operational') {
        sendPreviewJson(
          request,
          response,
          buildGamingQueryError(
            'OPERATIONAL_REQUEST_NOT_GAMEPLAY',
            'This request asks about the public integration rather than gameplay. Use the public canary operation.',
            'gaming_operational_guard',
            correlation
          ),
          400,
          MAX_GAMING_QUERY_RESPONSE_BYTES,
          'native_pr_preview.gaming_query_operational'
        );
        return;
      }
      sendPreviewJson(
        request,
        response,
        buildGamingQueryError(
          fixture.code,
          fixture.message,
          'gaming_validation',
          correlation
        ),
        400,
        MAX_GAMING_QUERY_RESPONSE_BYTES,
        'native_pr_preview.gaming_query_invalid'
      );
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionPath,
    (request, response) => {
      const fixture = request.header(
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtureHeader
      );
      const correlation = readPreviewCorrelation(response);
      const sourceFixtures =
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtures;
      const idempotencyKeys =
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.idempotencyKeys;
      if (fixture === undefined) {
        sendGamingSourceResponse(
          request,
          response,
          401,
          buildGamingSourceUnauthorized(),
          'native_pr_preview.gaming_source_unauthorized'
        );
        return;
      }
      if (fixture === sourceFixtures.validation) {
        if (
          !isExactGamingSourceIngestionBody(
            request.body,
            idempotencyKeys.validation,
            true
          )
        ) {
          sendFixedNotFound(request, response);
          return;
        }
        sendGamingSourceResponse(
          request,
          response,
          400,
          buildGamingSourceValidation(),
          'native_pr_preview.gaming_source_validation'
        );
        return;
      }
      const expectedKey = fixture === sourceFixtures.unsafe
        ? idempotencyKeys.unsafe
        : fixture === sourceFixtures.outage
          ? idempotencyKeys.outage
          : fixture === sourceFixtures.created
            ? idempotencyKeys.created
            : fixture === sourceFixtures.replay
              ? idempotencyKeys.replay
              : fixture === sourceFixtures.conflict
                ? idempotencyKeys.conflict
                : null;
      if (
        expectedKey === null
        || !isExactGamingSourceIngestionBody(request.body, expectedKey)
      ) {
        sendFixedNotFound(request, response);
        return;
      }
      if (fixture === sourceFixtures.unsafe) {
        sendGamingSourceResponse(
          request,
          response,
          503,
          buildGamingSourceUnsafe(correlation),
          'native_pr_preview.gaming_source_unsafe'
        );
        return;
      }
      if (fixture === sourceFixtures.outage) {
        sendGamingSourceResponse(
          request,
          response,
          503,
          buildGamingSourceOutage(),
          'native_pr_preview.gaming_source_outage'
        );
        return;
      }
      if (fixture === sourceFixtures.conflict) {
        sendGamingSourceResponse(
          request,
          response,
          409,
          {
            ok: false,
            error: {
              code: 'GAMING_SOURCE_IDEMPOTENCY_CONFLICT',
              message:
                'The idempotency key is already bound to a different ingestion request.',
            },
          },
          'native_pr_preview.gaming_source_conflict'
        );
        return;
      }
      sendGamingSourceResponse(
        request,
        response,
        202,
        buildGamingSourceQueued(
          'ingest',
          NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionIds.created,
          fixture === sourceFixtures.replay,
          correlation
        ),
        fixture === sourceFixtures.replay
          ? 'native_pr_preview.gaming_source_replay'
          : 'native_pr_preview.gaming_source_created'
      );
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.refreshPath,
    (request, response) => {
      const fixture = request.header(
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtureHeader
      );
      const correlation = readPreviewCorrelation(response);
      const sourceFixtures =
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtures;
      const idempotencyKeys =
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.idempotencyKeys;
      if (fixture === undefined) {
        sendGamingSourceResponse(
          request,
          response,
          401,
          buildGamingSourceUnauthorized(),
          'native_pr_preview.gaming_refresh_unauthorized'
        );
        return;
      }
      if (fixture === sourceFixtures.refreshValidation) {
        if (
          !isExactGamingSourceRefreshBody(
            request.body,
            idempotencyKeys.refreshValidation,
            true
          )
        ) {
          sendFixedNotFound(request, response);
          return;
        }
        sendGamingSourceResponse(
          request,
          response,
          400,
          buildGamingSourceValidation(),
          'native_pr_preview.gaming_refresh_validation'
        );
        return;
      }
      const expectedKey = fixture === sourceFixtures.refreshUnsafe
        ? idempotencyKeys.refreshUnsafe
        : fixture === sourceFixtures.refreshOutage
          ? idempotencyKeys.refreshOutage
          : fixture === sourceFixtures.refreshCreated
            ? idempotencyKeys.refreshCreated
            : null;
      if (
        expectedKey === null
        || !isExactGamingSourceRefreshBody(request.body, expectedKey)
      ) {
        sendFixedNotFound(request, response);
        return;
      }
      if (fixture === sourceFixtures.refreshUnsafe) {
        sendGamingSourceResponse(
          request,
          response,
          503,
          buildGamingSourceUnsafe(correlation),
          'native_pr_preview.gaming_refresh_unsafe'
        );
        return;
      }
      if (fixture === sourceFixtures.refreshOutage) {
        sendGamingSourceResponse(
          request,
          response,
          503,
          {
            ok: false,
            error: {
              code: 'GAMING_SOURCE_STORAGE_UNAVAILABLE',
              message: 'Gaming-source refresh storage is unavailable.',
            },
          },
          'native_pr_preview.gaming_refresh_outage'
        );
        return;
      }
      sendGamingSourceResponse(
        request,
        response,
        202,
        buildGamingSourceQueued(
          'refresh',
          NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionIds.refresh,
          false,
          correlation
        ),
        'native_pr_preview.gaming_refresh_created'
      );
    }
  );

  app.get(
    `${NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.statusPathPrefix}:ingestionId`,
    (request, response) => {
      const fixture = request.header(
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtureHeader
      );
      const correlation = readPreviewCorrelation(response);
      const sourceFixtures =
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.fixtures;
      const ingestionIds =
        NATIVE_PR_PREVIEW_GAMING_SOURCES_CONTRACT.ingestionIds;
      if (fixture === undefined) {
        sendGamingSourceResponse(
          request,
          response,
          401,
          buildGamingSourceUnauthorized(),
          'native_pr_preview.gaming_status_unauthorized'
        );
        return;
      }
      if (
        fixture === sourceFixtures.statusValidation
        && request.params.ingestionId === 'not-a-uuid'
      ) {
        sendGamingSourceResponse(
          request,
          response,
          400,
          {
            ok: false,
            error: {
              code: 'GAMING_SOURCE_VALIDATION_ERROR',
              message: 'ingestionId must be a UUID.',
            },
          },
          'native_pr_preview.gaming_status_validation'
        );
        return;
      }
      if (
        fixture === sourceFixtures.statusMissing
        && request.params.ingestionId === ingestionIds.missing
      ) {
        sendGamingSourceResponse(
          request,
          response,
          404,
          {
            ok: false,
            error: {
              code: 'GAMING_SOURCE_INGESTION_NOT_FOUND',
              message: 'The gaming-source ingestion was not found.',
            },
          },
          'native_pr_preview.gaming_status_missing'
        );
        return;
      }
      if (
        fixture === sourceFixtures.statusOutage
        && request.params.ingestionId === ingestionIds.outage
      ) {
        sendGamingSourceResponse(
          request,
          response,
          503,
          buildGamingSourceOutage(true),
          'native_pr_preview.gaming_status_outage'
        );
        return;
      }
      const status = fixture === sourceFixtures.statusQueued
        && request.params.ingestionId === ingestionIds.created
        ? 'queued'
        : fixture === sourceFixtures.statusRunning
          && request.params.ingestionId === ingestionIds.running
          ? 'running'
          : fixture === sourceFixtures.statusCompleted
            && request.params.ingestionId === ingestionIds.completed
            ? 'completed'
            : null;
      if (status === null) {
        sendFixedNotFound(request, response);
        return;
      }
      sendGamingSourceResponse(
        request,
        response,
        200,
        buildGamingSourceStatus(
          request.params.ingestionId,
          status,
          correlation
        ),
        `native_pr_preview.gaming_status_${status}`
      );
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path,
    (request, response, next) => {
      const body = request.body as unknown;
      const bodyKeys =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
          : [];
      const fixture =
        bodyKeys.length === 1 && bodyKeys[0] === 'fixture'
          ? (body as { fixture?: unknown }).fixture
          : undefined;
      if (
        typeof fixture !== 'string'
        || !RESEARCH_FIXTURE_NAMES.has(fixture)
      ) {
        return sendBoundedJsonResponse(
          request,
          response,
          { error: 'PREVIEW_RESEARCH_FIXTURE_INVALID' },
          {
            logEvent: 'native_pr_preview.research_fixture_invalid',
            maxBytes: MAX_RESEARCH_RESPONSE_BYTES,
            statusCode: 400,
          }
        );
      }

      void runSyntheticResearchFixture(fixture)
        .then(result => sendBoundedJsonResponse(
          request,
          response,
          result.payload,
          {
            logEvent: 'native_pr_preview.research_fixture',
            maxBytes: MAX_RESEARCH_RESPONSE_BYTES,
            statusCode: result.statusCode,
          }
        ))
        .catch(next);
      return undefined;
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path,
    (request, response, next) => {
      const body = request.body as unknown;
      const bodyKeys =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
          : [];
      const fixture =
        bodyKeys.length === 1 && bodyKeys[0] === 'fixture'
          ? (body as { fixture?: unknown }).fixture
          : undefined;
      if (
        typeof fixture !== 'string'
        || !STORYLINE_FIXTURE_NAMES.has(fixture)
      ) {
        return sendBoundedJsonResponse(
          request,
          response,
          { error: 'PREVIEW_BACKSTAGE_STORYLINE_FIXTURE_INVALID' },
          {
            logEvent: 'native_pr_preview.backstage_storyline_fixture_invalid',
            maxBytes: MAX_STORYLINE_RESPONSE_BYTES,
            statusCode: 400,
          }
        );
      }

      void runStorylineFixture(fixture)
        .then(result => sendBoundedJsonResponse(
          request,
          response,
          result.payload,
          {
            logEvent: 'native_pr_preview.backstage_storyline_fixture',
            maxBytes: MAX_STORYLINE_RESPONSE_BYTES,
            statusCode: result.statusCode,
          }
        ))
        .catch(next);
      return undefined;
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT.path,
    (request, response, next) => {
      const body = request.body as unknown;
      const bodyKeys =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
          : [];
      const fixture =
        bodyKeys.length === 1 && bodyKeys[0] === 'fixture'
          ? (body as { fixture?: unknown }).fixture
          : undefined;
      if (
        typeof fixture !== 'string'
        || !BACKSTAGE_GENERATION_FIXTURE_NAMES.has(fixture)
      ) {
        return sendBoundedJsonResponse(
          request,
          response,
          { error: 'PREVIEW_BACKSTAGE_GENERATION_FIXTURE_INVALID' },
          {
            logEvent: 'native_pr_preview.backstage_generation_fixture_invalid',
            maxBytes: MAX_BACKSTAGE_GENERATION_RESPONSE_BYTES,
            statusCode: 400,
          }
        );
      }

      void runBackstageGenerationFixture(fixture)
        .then(payload => sendBoundedJsonResponse(
          request,
          response,
          payload,
          {
            logEvent: 'native_pr_preview.backstage_generation_fixture',
            maxBytes: MAX_BACKSTAGE_GENERATION_RESPONSE_BYTES,
            statusCode: 200,
          }
        ))
        .catch(next);
      return undefined;
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_MCP_BODY_CAP_CONTRACT.path,
    (request, response, next) => {
      const body = request.body as unknown;
      const bodyKeys =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
          : [];
      const fixture =
        bodyKeys.length === 1 && bodyKeys[0] === 'fixture'
          ? (body as { fixture?: unknown }).fixture
          : undefined;
      if (
        typeof fixture !== 'string'
        || !MCP_BODY_CAP_FIXTURE_NAMES.has(fixture)
      ) {
        return sendBoundedJsonResponse(
          request,
          response,
          { error: 'PREVIEW_MCP_BODY_CAP_FIXTURE_INVALID' },
          {
            logEvent: 'native_pr_preview.mcp_body_cap_fixture_invalid',
            maxBytes: MAX_MCP_BODY_CAP_RESPONSE_BYTES,
            statusCode: 400,
          }
        );
      }

      void runMcpBodyCapFixture(fixture)
        .then(result => sendBoundedJsonResponse(
          request,
          response,
          result.payload,
          {
            logEvent: 'native_pr_preview.mcp_body_cap_fixture',
            maxBytes: MAX_MCP_BODY_CAP_RESPONSE_BYTES,
            statusCode: result.statusCode,
          }
        ))
        .catch(next);
      return undefined;
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_SELF_HEAL_APPROVAL_CONTRACT.path,
    (request, response) => {
      const body = request.body as unknown;
      const bodyKeys =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
          : [];
      const fixture =
        bodyKeys.length === 1 && bodyKeys[0] === 'fixture'
          ? (body as { fixture?: unknown }).fixture
          : undefined;
      if (
        typeof fixture !== 'string'
        || !SELF_HEAL_APPROVAL_FIXTURE_NAMES.has(fixture)
      ) {
        return sendBoundedJsonResponse(
          request,
          response,
          { error: 'PREVIEW_SELF_HEAL_APPROVAL_FIXTURE_INVALID' },
          {
            logEvent: 'native_pr_preview.self_heal_approval_fixture_invalid',
            maxBytes: MAX_SELF_HEAL_APPROVAL_RESPONSE_BYTES,
            statusCode: 400,
          }
        );
      }

      return sendBoundedJsonResponse(
        request,
        response,
        runSelfHealApprovalFixture(fixture),
        {
          logEvent: 'native_pr_preview.self_heal_approval_fixture',
          maxBytes: MAX_SELF_HEAL_APPROVAL_RESPONSE_BYTES,
          statusCode: 200,
        }
      );
    }
  );

  app.use('/', createGenericJobsRouter({
    confirmCancellation: (_request, _response, next) => next(),
    getJobById: fixtureRepository.getJobById,
    getRequestActorKey: () => FIXTURE_ACTOR_KEY,
    getRequestEstablishedActorKey: () => FIXTURE_ACTOR_KEY,
    isJobRepositoryUnavailable: (error) =>
      error instanceof NativePrPreviewRepositoryUnavailableError,
    recordJobLookup: () => undefined,
    requestJobCancellation: fixtureRepository.requestJobCancellation,
    sleep: async () => {
      throw new Error('PREVIEW_APPLICATION_STREAM_DISABLED');
    },
    validateBridgeCredential: () => ({
      ok: false,
      statusCode: 503,
      reason: 'unconfigured',
    }),
    verifyJobReadCapability: (jobId) => {
      if (jobId === NATIVE_PR_PREVIEW_FIXTURE_IDS.authUnavailable) {
        return { available: false, authorized: false };
      }
      return {
        available: true,
        authorized:
          jobId !== NATIVE_PR_PREVIEW_FIXTURE_IDS.unauthorized,
      };
    },
  }));

  app.use((request, response) => {
    sendFixedNotFound(request, response);
  });

  app.use((
    _error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(400).json({ error: 'PREVIEW_REQUEST_INVALID' });
  });

  return app;
}
