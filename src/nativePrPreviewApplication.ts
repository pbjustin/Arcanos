import express from 'express';

import {
  createGenericJobsRouter,
  type GenericJobData,
} from './routes/genericJobsRouter.js';
import {
  NATIVE_PR_PREVIEW_FIXTURE_IDS,
  NATIVE_PR_PREVIEW_MODE,
  NATIVE_PR_PREVIEW_RESEARCH_CONTRACT,
  NATIVE_PR_PREVIEW_TRUST_SCOPE,
  type NativePrPreviewIdentity,
} from './nativePrPreviewContract.js';
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
  sendBoundedJsonResponse,
} from './shared/http/sendBoundedJsonResponse.js';

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESEARCH_RESPONSE_BYTES = 4 * 1024;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9]\d*)$/u;
const FIXTURE_ACTOR_KEY = 'operator:native-pr-preview-fixture';
const FIXTURE_TIMESTAMP = new Date('2026-07-30T00:00:00.000Z');
const FIXTURE_COMPLETED_TIMESTAMP = new Date('2026-07-30T00:00:01.000Z');
const SAFE_SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
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
const SNAPSHOT_FIRST_URL = 'https://example.invalid/first-snapshot';
const SNAPSHOT_SECOND_URL = 'https://example.invalid/second-snapshot';
const STORAGE_COMPONENT_TOPIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

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

function runSyntheticResearchFixture(fixture: string): SyntheticResearchResult {
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

function buildAllowedRouteKeys(): Set<string> {
  const allowed = new Set([
    'GET /health',
    'HEAD /health',
    'GET /healthz',
    'HEAD /healthz',
    'GET /readyz',
    'HEAD /readyz',
    `POST ${NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path}`,
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
    limit: MAX_REQUEST_BYTES,
    strict: true,
  });

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    const rawUrl = request.url ?? '';
    const rawPath = rawUrl.split('?', 1)[0] ?? '';
    const routeKey = `${request.method ?? ''} ${rawPath}`;
    const contentLength = request.header('content-length');
    const parsedContentLength = contentLength === undefined
      ? 0
      : Number.parseInt(contentLength, 10);
    const isPost = request.method === 'POST';
    const contentType = request.header('content-type') ?? '';

    if (
      rawUrl.includes('?')
      || rawPath.includes('%')
      || !allowedRouteKeys.has(routeKey)
      || isCredentialCarrierPresent(request)
      || request.header('content-encoding') !== undefined
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
    jsonBodyParser(request, response, next);
  });

  app.post(
    NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path,
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

      const result = runSyntheticResearchFixture(fixture);
      return sendBoundedJsonResponse(
        request,
        response,
        result.payload,
        {
          logEvent: 'native_pr_preview.research_fixture',
          maxBytes: MAX_RESEARCH_RESPONSE_BYTES,
          statusCode: result.statusCode,
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
