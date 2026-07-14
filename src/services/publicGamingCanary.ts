import {
  loadPublicGamingCanaryFixture,
  PUBLIC_GAMING_CANARY_MARKER,
  PUBLIC_GAMING_CANARY_SENTENCE
} from '@services/publicGamingCanaryFixture.js';
import { isRecord } from '@shared/typeGuards.js';

export const PUBLIC_GAMING_CANARY_SCHEMA_VERSION = '1.4.0';
export const PUBLIC_GAMING_CANARY_MAX_RESPONSE_BYTES = 2_048;

const MAX_FIXTURE_BYTES = 512;
const MAX_PROJECTION_BYTES = 1_024;
const MAX_DURATION_MS = 30_000;
const SAFE_CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANARY_CHECK_KEYS = [
  'requestValidation',
  'dispatcher',
  'publicRoute',
  'fixtureValidation',
  'grounding',
  'networkRetrieval',
  'providerExecution',
  'responseConstruction',
  'responseGuard'
] as const;

type PublicGamingCanaryCheckStatus = 'passed' | 'failed' | 'skipped';

export type PublicGamingCanaryChecks = Record<
  (typeof CANARY_CHECK_KEYS)[number],
  PublicGamingCanaryCheckStatus
>;

export type PublicGamingCanaryFailureCode =
  | 'BAD_REQUEST'
  | 'PUBLIC_CANARY_UNAVAILABLE'
  | 'PUBLIC_CANARY_FIXTURE_UNAVAILABLE'
  | 'PUBLIC_CANARY_FIXTURE_INVALID'
  | 'PUBLIC_CANARY_GROUNDING_FAILED'
  | 'PUBLIC_CANARY_RESPONSE_GUARD_FAILED';

type PublicGamingCanaryCommonResponse = {
  action: 'canary';
  scope: 'public_pipeline';
  schemaVersion: '1.4.0';
  intent: 'public_canary';
  route: 'public_canary';
  message: string;
  requestId: string;
  traceId: string;
  checks: PublicGamingCanaryChecks;
  usedFallback: boolean;
  acceptedSources: number;
  durationMs: number;
};

export type PublicGamingCanarySuccessResponse = PublicGamingCanaryCommonResponse & {
  ok: true;
  fixture: {
    source: 'bundled';
    marker: 'ARCANOS_PUBLIC_CANARY_7F31';
    markerVerified: true;
  };
  usedFallback: false;
  acceptedSources: 1;
};

export type PublicGamingCanaryFailureResponse = PublicGamingCanaryCommonResponse & {
  ok: false;
  code: PublicGamingCanaryFailureCode;
};

export type PublicGamingCanaryResponse =
  | PublicGamingCanarySuccessResponse
  | PublicGamingCanaryFailureResponse;

type ValidatedPublicGamingCanaryFixture = {
  marker: typeof PUBLIC_GAMING_CANARY_MARKER;
  sentence: typeof PUBLIC_GAMING_CANARY_SENTENCE;
};

export type PublicGamingCanaryDependencies = {
  loadFixture: () => string;
  now: () => number;
  projectFixture: (fixture: ValidatedPublicGamingCanaryFixture) => string;
  guardResponse: (response: PublicGamingCanaryResponse) => boolean;
};

const FAILURE_MESSAGES: Record<PublicGamingCanaryFailureCode, string> = {
  BAD_REQUEST: "Public canary requests require action 'canary' and scope 'public_pipeline'.",
  PUBLIC_CANARY_UNAVAILABLE:
    'The public ARCANOS Gaming Action pipeline is temporarily unavailable.',
  PUBLIC_CANARY_FIXTURE_UNAVAILABLE: 'The public canary fixture is temporarily unavailable.',
  PUBLIC_CANARY_FIXTURE_INVALID: 'The public canary fixture failed validation.',
  PUBLIC_CANARY_GROUNDING_FAILED: 'The public canary fixture failed deterministic grounding.',
  PUBLIC_CANARY_RESPONSE_GUARD_FAILED: 'The public canary response failed its runtime guard.'
};
const FAILURE_CODES = new Set<PublicGamingCanaryFailureCode>([
  'BAD_REQUEST',
  'PUBLIC_CANARY_UNAVAILABLE',
  'PUBLIC_CANARY_FIXTURE_UNAVAILABLE',
  'PUBLIC_CANARY_FIXTURE_INVALID',
  'PUBLIC_CANARY_GROUNDING_FAILED',
  'PUBLIC_CANARY_RESPONSE_GUARD_FAILED'
]);

const SUCCESS_MESSAGE = 'Public ARCANOS Gaming Action pipeline canary passed.';

function hasExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(record);
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key) => expectedKeys.includes(key));
}

function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CORRELATION_ID_PATTERN.test(value);
}

function normalizeCorrelationId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim() ?? '';
  return SAFE_CORRELATION_ID_PATTERN.test(trimmed) ? trimmed : fallback;
}

function normalizeCanaryIds(requestId: string | undefined, traceId: string | undefined) {
  const safeRequestId = normalizeCorrelationId(requestId, 'unknown');
  return {
    requestId: safeRequestId,
    traceId: normalizeCorrelationId(traceId, safeRequestId)
  };
}

function clampDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) {
    return 0;
  }
  return Math.min(MAX_DURATION_MS, Math.max(0, Math.trunc(durationMs)));
}

function readClock(now: () => number, fallback: number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function resolveDuration(now: () => number, startedAt: number): number {
  return clampDuration(readClock(now, startedAt) - startedAt);
}

function parseCanaryFixture(value: unknown): ValidatedPublicGamingCanaryFixture | null {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_FIXTURE_BYTES) {
    return null;
  }

  const lines = value.split('\n');
  if (
    lines.length !== 2
    || lines[0] !== `${PUBLIC_GAMING_CANARY_MARKER}:`
    || lines[1] !== PUBLIC_GAMING_CANARY_SENTENCE
  ) {
    return null;
  }

  return {
    marker: PUBLIC_GAMING_CANARY_MARKER,
    sentence: PUBLIC_GAMING_CANARY_SENTENCE
  };
}

function projectCanaryFixture(fixture: ValidatedPublicGamingCanaryFixture): string {
  return `${fixture.marker}: ${fixture.sentence}`;
}

function projectionIsGrounded(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= MAX_PROJECTION_BYTES
    && value.includes(PUBLIC_GAMING_CANARY_MARKER)
    && value.includes(PUBLIC_GAMING_CANARY_SENTENCE);
}

function successChecks(): PublicGamingCanaryChecks {
  return {
    requestValidation: 'passed',
    dispatcher: 'passed',
    publicRoute: 'passed',
    fixtureValidation: 'passed',
    grounding: 'passed',
    networkRetrieval: 'skipped',
    providerExecution: 'skipped',
    responseConstruction: 'passed',
    responseGuard: 'passed'
  };
}

function failureChecks(code: PublicGamingCanaryFailureCode): PublicGamingCanaryChecks {
  const checks: PublicGamingCanaryChecks = {
    requestValidation: 'passed',
    dispatcher: 'passed',
    publicRoute: 'passed',
    fixtureValidation: 'skipped',
    grounding: 'skipped',
    networkRetrieval: 'skipped',
    providerExecution: 'skipped',
    responseConstruction: 'passed',
    responseGuard: 'passed'
  };

  if (code === 'BAD_REQUEST') {
    checks.requestValidation = 'failed';
    checks.dispatcher = 'skipped';
    checks.fixtureValidation = 'skipped';
  } else if (code === 'PUBLIC_CANARY_UNAVAILABLE') {
    checks.publicRoute = 'failed';
  } else if (
    code === 'PUBLIC_CANARY_FIXTURE_UNAVAILABLE'
    || code === 'PUBLIC_CANARY_FIXTURE_INVALID'
  ) {
    checks.fixtureValidation = 'failed';
  } else if (code === 'PUBLIC_CANARY_GROUNDING_FAILED') {
    checks.fixtureValidation = 'passed';
    checks.grounding = 'failed';
  } else {
    checks.fixtureValidation = 'passed';
    checks.grounding = 'passed';
    checks.responseGuard = 'failed';
  }

  return checks;
}

function expectedFailureAcceptedSources(code: PublicGamingCanaryFailureCode): number {
  return code === 'PUBLIC_CANARY_RESPONSE_GUARD_FAILED' ? 1 : 0;
}

function statusForFailure(code: PublicGamingCanaryFailureCode): 400 | 500 | 503 {
  if (code === 'BAD_REQUEST') {
    return 400;
  }
  return code === 'PUBLIC_CANARY_RESPONSE_GUARD_FAILED' ? 500 : 503;
}

export function buildPublicGamingCanaryFailure(params: {
  code: PublicGamingCanaryFailureCode;
  requestId?: string;
  traceId?: string;
  durationMs?: number;
}): PublicGamingCanaryFailureResponse {
  const ids = normalizeCanaryIds(params.requestId, params.traceId);
  const usedFallback = params.code === 'PUBLIC_CANARY_RESPONSE_GUARD_FAILED';
  return {
    ok: false,
    action: 'canary',
    scope: 'public_pipeline',
    schemaVersion: PUBLIC_GAMING_CANARY_SCHEMA_VERSION,
    intent: 'public_canary',
    route: 'public_canary',
    message: FAILURE_MESSAGES[params.code],
    ...ids,
    code: params.code,
    checks: failureChecks(params.code),
    usedFallback,
    acceptedSources: expectedFailureAcceptedSources(params.code),
    durationMs: clampDuration(params.durationMs ?? 0)
  };
}

function hasValidChecks(value: unknown): value is PublicGamingCanaryChecks {
  if (!isRecord(value) || !hasExactKeys(value, CANARY_CHECK_KEYS)) {
    return false;
  }
  return CANARY_CHECK_KEYS.every((key) => (
    value[key] === 'passed' || value[key] === 'failed' || value[key] === 'skipped'
  ));
}

function checksEqual(
  actual: PublicGamingCanaryChecks,
  expected: PublicGamingCanaryChecks
): boolean {
  return CANARY_CHECK_KEYS.every((key) => actual[key] === expected[key]);
}

function hasValidCommonResponse(value: Record<string, unknown>): boolean {
  return value.action === 'canary'
    && value.scope === 'public_pipeline'
    && value.schemaVersion === PUBLIC_GAMING_CANARY_SCHEMA_VERSION
    && value.intent === 'public_canary'
    && value.route === 'public_canary'
    && typeof value.message === 'string'
    && value.message.trim().length > 0
    && value.message.length <= 160
    && isSafeCorrelationId(value.requestId)
    && isSafeCorrelationId(value.traceId)
    && hasValidChecks(value.checks)
    && typeof value.usedFallback === 'boolean'
    && Number.isInteger(value.acceptedSources)
    && Number.isInteger(value.durationMs)
    && (value.durationMs as number) >= 0
    && (value.durationMs as number) <= MAX_DURATION_MS;
}

function isBoundedCanaryResponse(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= PUBLIC_GAMING_CANARY_MAX_RESPONSE_BYTES;
  } catch {
    return false;
  }
}

export function guardPublicGamingCanaryResponse(
  value: unknown
): value is PublicGamingCanaryResponse {
  if (!isRecord(value) || !hasValidCommonResponse(value) || !isBoundedCanaryResponse(value)) {
    return false;
  }

  if (value.ok === true) {
    if (!hasExactKeys(value, [
      'ok',
      'action',
      'scope',
      'schemaVersion',
      'intent',
      'route',
      'message',
      'requestId',
      'traceId',
      'fixture',
      'checks',
      'usedFallback',
      'acceptedSources',
      'durationMs'
    ])) {
      return false;
    }
    if (!isRecord(value.fixture) || !hasExactKeys(value.fixture, [
      'source',
      'marker',
      'markerVerified'
    ])) {
      return false;
    }
    return value.message === SUCCESS_MESSAGE
      && value.fixture.source === 'bundled'
      && value.fixture.marker === PUBLIC_GAMING_CANARY_MARKER
      && value.fixture.markerVerified === true
      && checksEqual(value.checks as PublicGamingCanaryChecks, successChecks())
      && value.usedFallback === false
      && value.acceptedSources === 1;
  }

  if (value.ok !== false || !hasExactKeys(value, [
    'ok',
    'action',
    'scope',
    'schemaVersion',
    'intent',
    'route',
    'message',
    'requestId',
    'traceId',
    'code',
    'checks',
    'usedFallback',
    'acceptedSources',
    'durationMs'
  ])) {
    return false;
  }
  if (
    typeof value.code !== 'string'
    || !FAILURE_CODES.has(value.code as PublicGamingCanaryFailureCode)
  ) {
    return false;
  }

  const code = value.code as PublicGamingCanaryFailureCode;
  return value.message === FAILURE_MESSAGES[code]
    && checksEqual(value.checks as PublicGamingCanaryChecks, failureChecks(code))
    && value.usedFallback === (code === 'PUBLIC_CANARY_RESPONSE_GUARD_FAILED')
    && value.acceptedSources === expectedFailureAcceptedSources(code);
}

export function executePublicGamingCanary(params: {
  requestId?: string;
  traceId?: string;
  startedAtMs?: number;
  dependencies?: Partial<PublicGamingCanaryDependencies>;
}): { statusCode: 200 | 400 | 500 | 503; response: PublicGamingCanaryResponse } {
  const dependencies: PublicGamingCanaryDependencies = {
    loadFixture: params.dependencies?.loadFixture ?? loadPublicGamingCanaryFixture,
    now: params.dependencies?.now ?? Date.now,
    projectFixture: params.dependencies?.projectFixture ?? projectCanaryFixture,
    guardResponse: params.dependencies?.guardResponse ?? (() => true)
  };
  const startedAt = typeof params.startedAtMs === 'number' && Number.isFinite(params.startedAtMs)
    ? params.startedAtMs
    : readClock(dependencies.now, 0);
  const ids = normalizeCanaryIds(params.requestId, params.traceId);

  let fixtureSource: unknown;
  try {
    fixtureSource = dependencies.loadFixture();
  } catch {
    const response = buildPublicGamingCanaryFailure({
      code: 'PUBLIC_CANARY_FIXTURE_UNAVAILABLE',
      ...ids,
      durationMs: resolveDuration(dependencies.now, startedAt)
    });
    return { statusCode: statusForFailure(response.code), response };
  }

  const fixture = parseCanaryFixture(fixtureSource);
  if (!fixture) {
    const response = buildPublicGamingCanaryFailure({
      code: 'PUBLIC_CANARY_FIXTURE_INVALID',
      ...ids,
      durationMs: resolveDuration(dependencies.now, startedAt)
    });
    return { statusCode: statusForFailure(response.code), response };
  }

  let projection: unknown;
  try {
    projection = dependencies.projectFixture(fixture);
  } catch {
    projection = null;
  }
  if (!projectionIsGrounded(projection)) {
    const response = buildPublicGamingCanaryFailure({
      code: 'PUBLIC_CANARY_GROUNDING_FAILED',
      ...ids,
      durationMs: resolveDuration(dependencies.now, startedAt)
    });
    return { statusCode: statusForFailure(response.code), response };
  }

  const response: PublicGamingCanarySuccessResponse = {
    ok: true,
    action: 'canary',
    scope: 'public_pipeline',
    schemaVersion: PUBLIC_GAMING_CANARY_SCHEMA_VERSION,
    intent: 'public_canary',
    route: 'public_canary',
    message: SUCCESS_MESSAGE,
    ...ids,
    fixture: {
      source: 'bundled',
      marker: PUBLIC_GAMING_CANARY_MARKER,
      markerVerified: true
    },
    checks: successChecks(),
    usedFallback: false,
    acceptedSources: 1,
    durationMs: resolveDuration(dependencies.now, startedAt)
  };

  let injectedGuardPassed = false;
  try {
    injectedGuardPassed = dependencies.guardResponse(response);
  } catch {
    injectedGuardPassed = false;
  }
  if (!guardPublicGamingCanaryResponse(response) || !injectedGuardPassed) {
    const fallback = buildPublicGamingCanaryFailure({
      code: 'PUBLIC_CANARY_RESPONSE_GUARD_FAILED',
      ...ids,
      durationMs: resolveDuration(dependencies.now, startedAt)
    });
    return { statusCode: statusForFailure(fallback.code), response: fallback };
  }

  return { statusCode: 200, response };
}
