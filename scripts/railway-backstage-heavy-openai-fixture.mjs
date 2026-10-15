#!/usr/bin/env node
/**
 * Credential-free OpenAI wire fixture for the isolated Backstage heavy-flow proof.
 *
 * The dedicated proof supervisor is the only supported parent. It starts this
 * process in the worker container with an exact, credential-empty environment,
 * then launches the normal integrity wrapper separately. The server binds
 * loopback, accepts one health probe plus exactly two Responses calls, and
 * exposes only bounded counters for later attestation.
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_MARKER =
  'backstage-heavy-compact-retry-v1';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ARGUMENT = '--serve-v1';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV =
  'ARCANOS_BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_VALUE = 'v1';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUN_ID_ENV =
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_RUN_ID';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST = '127.0.0.1';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_PORT = 8766;
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_BASE_URL =
  `http://${BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST}:${BACKSTAGE_HEAVY_OPENAI_FIXTURE_PORT}/v1`;
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_SENTINEL =
  'ARCANOS_BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_V1';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH =
  '/__arcanos/backstage-heavy-openai-fixture/attestation';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY =
  'arcanos-preview-fixture-protocol-v1';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL =
  'ARCANOS_BACKSTAGE_HEAVY_COMPACT_RETRY_FIXTURE_V1';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE =
  'Generate exactly six numbered booking items';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT =
  'Fictional preview draft stopped before completion.';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT = [
  '1. Aurora Vale opens the fictional showcase by earning a clean technical victory over Nova Quinn.',
  '2. Orion Pike answers Cassian Reed\'s challenge and schedules their fictional rematch for the next event.',
  '3. Mira Sol protects her fictional championship by surviving Elara Frost\'s late counterattack.',
  '4. The fictional Harbor Lights duo defeats the Iron Comets after a disciplined closing sequence.',
  '5. Sable North interrupts Rowan Crest and establishes the fictional rivalry that anchors the next chapter.',
  '6. Atlas Wren closes the fictional card with a decisive win while every other story remains unresolved.',
].join('\n');

const MAX_REQUEST_BYTES = 512 * 1024;
const DEFAULT_FIRST_RESPONSE_DELAY_MS = 12_000;
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID =
  'ft:gpt-4.1:synthetic:backstage-heavy-authority';
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT = 6_000;
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER =
  '<<OUTPUT_LENGTH_RECOVERY>>';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function writeJson(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function writeOpenAIError(response, statusCode, code) {
  writeJson(response, statusCode, {
    error: {
      code,
      message: 'The isolated preview fixture rejected this request.',
      type: 'invalid_request_error',
    },
  });
}

function hasFixtureAuthorization(request, key = BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY) {
  return request.headers.authorization
    === `Bearer ${key}`;
}

function parseRequestUrl(request) {
  try {
    return new URL(
      request.url ?? '',
      `http://${BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST}`
    );
  } catch {
    return null;
  }
}

function hasNoQuery(requestUrl) {
  return requestUrl.searchParams.size === 0;
}

async function readBoundedJson(request) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      return { ok: false, code: 'fixture_request_too_large' };
    }
    chunks.push(buffer);
  }

  try {
    const rawBody = Buffer.concat(chunks, totalBytes).toString('utf8');
    const parsed = JSON.parse(rawBody);
    if (!isRecord(parsed)) {
      return { ok: false, code: 'fixture_request_invalid' };
    }
    return {
      ok: true,
      body: parsed,
    };
  } catch {
    return { ok: false, code: 'fixture_request_invalid' };
  }
}

function readResponsesInputText(body) {
  if (!Array.isArray(body.input) || body.input.length === 0) {
    return null;
  }
  const allText = [];
  const userText = [];
  for (const item of body.input) {
    if (
      !isRecord(item)
      || (item.role !== 'developer' && item.role !== 'user')
      || !Array.isArray(item.content)
      || item.content.length === 0
    ) {
      return null;
    }
    for (const content of item.content) {
      if (
        !isRecord(content)
        || content.type !== 'input_text'
        || typeof content.text !== 'string'
        || content.text.length === 0
      ) {
        return null;
      }
      allText.push(content.text);
      if (item.role === 'user') {
        userText.push(content.text);
      }
    }
  }
  return {
    allText: allText.join('\n'),
    userText: userText.join('\n'),
  };
}

function validateResponsesRequest(body, callNumber, expectedRunId) {
  const inputText = readResponsesInputText(body);
  const bookingDirectiveCount = inputText === null
    ? 0
    : inputText.userText.split(
        BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE
      ).length - 1;
  const runMarker = expectedRunId ? `Run ${expectedRunId}.` : null;
  const runMarkerCount = inputText === null || runMarker === null
    ? 0
    : inputText.userText.split(runMarker).length - 1;
  if (
    body.model !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID
    || body.max_output_tokens
      !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT
    || inputText === null
    || !inputText.userText.includes(
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL
    )
    || inputText.userText.length < 1_200
    || bookingDirectiveCount !== 1
    || (runMarker !== null && runMarkerCount !== 1)
  ) {
    return null;
  }
  const recoveryMarkerObserved = inputText.allText.includes(
    BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER
  );
  if (
    (callNumber === 1 && recoveryMarkerObserved)
    || (callNumber === 2 && !recoveryMarkerObserved)
    || (
      callNumber === 2
      && inputText.allText.includes(
        BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT
      )
    )
  ) {
    return null;
  }
  return {
    bookingDirectiveObserved: true,
    recoveryMarkerObserved,
    runMarkerObserved: runMarker !== null && runMarkerCount === 1,
  };
}

function buildResponseWireBody({ callNumber, model, status, text }) {
  const incomplete = status === 'incomplete';
  return {
    id: `resp_arcanos_backstage_heavy_fixture_${callNumber}`,
    object: 'response',
    created_at: 0,
    status,
    error: null,
    incomplete_details: incomplete
      ? { reason: 'max_output_tokens' }
      : null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [{
      id: `msg_arcanos_backstage_heavy_fixture_${callNumber}`,
      type: 'message',
      status,
      role: 'assistant',
      content: [{
        type: 'output_text',
        text,
        annotations: [],
        logprobs: [],
      }],
    }],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    truncation: 'disabled',
    usage: {
      input_tokens: 64,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: incomplete ? 12 : 128,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: incomplete ? 76 : 192,
    },
    metadata: {},
  };
}

export function createBackstageHeavyOpenAIFixtureState() {
  return {
    ready: true,
    modelsListCalls: 0,
    responsePhase: 'idle',
    responsesCalls: 0,
    firstResponseIncomplete: false,
    secondResponseCompleted: false,
    firstRecoveryMarkerAbsent: false,
    secondRecoveryMarkerObserved: false,
    secondRequestExcludedPartialOutput: false,
    thirdResponseRejected: 0,
    unknownRequests: 0,
    authorizationFailures: 0,
    invalidRequests: 0,
    promptSentinelObserved: false,
    bookingDirectiveObserved: false,
    runMarkerObserved: false,
  };
}

export function projectBackstageHeavyOpenAIFixtureAttestation(state) {
  return {
    schemaVersion: 1,
    fixture: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MARKER,
    ready: state.ready === true,
    modelsListCalls: Number(state.modelsListCalls) || 0,
    responsePhase: [
      'idle',
      'first_in_flight',
      'first_complete',
      'second_complete',
    ].includes(state.responsePhase)
      ? state.responsePhase
      : 'invalid',
    responsesCalls: Number(state.responsesCalls) || 0,
    firstResponseIncomplete: state.firstResponseIncomplete === true,
    secondResponseCompleted: state.secondResponseCompleted === true,
    firstRecoveryMarkerAbsent: state.firstRecoveryMarkerAbsent === true,
    secondRecoveryMarkerObserved:
      state.secondRecoveryMarkerObserved === true,
    secondRequestExcludedPartialOutput:
      state.secondRequestExcludedPartialOutput === true,
    thirdResponseRejected: Number(state.thirdResponseRejected) || 0,
    unknownRequests: Number(state.unknownRequests) || 0,
    authorizationFailures: Number(state.authorizationFailures) || 0,
    invalidRequests: Number(state.invalidRequests) || 0,
    promptSentinelObserved: state.promptSentinelObserved === true,
    bookingDirectiveObserved: state.bookingDirectiveObserved === true,
    runMarkerObserved: state.runMarkerObserved === true,
  };
}

export function createBackstageHeavyOpenAIFixtureServer(options = {}) {
  const state = options.state ?? createBackstageHeavyOpenAIFixtureState();
  const firstResponseDelayMs = Number.isSafeInteger(options.firstResponseDelayMs)
    && options.firstResponseDelayMs >= 0
    ? options.firstResponseDelayMs
    : DEFAULT_FIRST_RESPONSE_DELAY_MS;
  const expectedRunId = typeof options.expectedRunId === 'string'
    && /^[a-z0-9][a-z0-9-]{7,63}$/u.test(options.expectedRunId)
    ? options.expectedRunId
    : null;

  const server = createServer(async (request, response) => {
    const requestUrl = parseRequestUrl(request);
    const requestMethod = request.method ?? '';

    if (!hasFixtureAuthorization(request)) {
      state.authorizationFailures += 1;
      writeOpenAIError(response, 401, 'fixture_authorization_required');
      return;
    }

    if (
      requestMethod === 'GET'
      && requestUrl?.pathname === BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH
      && hasNoQuery(requestUrl)
    ) {
      writeJson(
        response,
        200,
        projectBackstageHeavyOpenAIFixtureAttestation(state)
      );
      return;
    }

    if (
      requestMethod === 'GET'
      && requestUrl?.pathname === '/v1/models'
      && hasNoQuery(requestUrl)
    ) {
      state.modelsListCalls += 1;
      writeJson(response, 200, {
        object: 'list',
        data: [{
          id: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
          object: 'model',
          created: 0,
          owned_by: 'arcanos-preview-fixture',
        }],
      });
      return;
    }

    if (
      requestMethod === 'POST'
      && requestUrl?.pathname === '/v1/responses'
      && hasNoQuery(requestUrl)
    ) {
      const parsedRequest = await readBoundedJson(request);
      const callNumber = state.responsePhase === 'idle'
        ? 1
        : state.responsePhase === 'first_complete'
          ? 2
          : null;
      const validatedRequest = parsedRequest.ok
        && callNumber !== null
        && state.modelsListCalls === 1
        ? validateResponsesRequest(
            parsedRequest.body,
            callNumber,
            expectedRunId
          )
        : null;
      if (
        !parsedRequest.ok
        || validatedRequest === null
      ) {
        if (state.responsePhase === 'second_complete') {
          state.thirdResponseRejected += 1;
        } else {
          state.invalidRequests += 1;
        }
        writeOpenAIError(
          response,
          parsedRequest.ok ? 422 : 400,
          parsedRequest.ok
            ? callNumber === null
              ? 'fixture_response_phase_invalid'
              : 'fixture_prompt_contract_mismatch'
            : parsedRequest.code
        );
        return;
      }

      state.promptSentinelObserved = true;
      state.bookingDirectiveObserved =
        validatedRequest.bookingDirectiveObserved === true;
      state.runMarkerObserved = validatedRequest.runMarkerObserved === true;
      state.responsesCalls += 1;
      if (callNumber === 1) {
        state.responsePhase = 'first_in_flight';
        await new Promise(resolve => setTimeout(resolve, firstResponseDelayMs));
        state.firstResponseIncomplete = true;
        state.firstRecoveryMarkerAbsent = true;
        state.responsePhase = 'first_complete';
        writeJson(response, 200, buildResponseWireBody({
          callNumber,
          model: parsedRequest.body.model,
          status: 'incomplete',
          text: BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
        }));
        return;
      }
      if (callNumber === 2) {
        state.secondResponseCompleted = true;
        state.secondRecoveryMarkerObserved = true;
        state.secondRequestExcludedPartialOutput = true;
        state.responsePhase = 'second_complete';
        writeJson(response, 200, buildResponseWireBody({
          callNumber,
          model: parsedRequest.body.model,
          status: 'completed',
          text: BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
        }));
        return;
      }
    }

    state.unknownRequests += 1;
    writeOpenAIError(response, 404, 'fixture_route_not_found');
  });

  return { server, state };
}

export async function startBackstageHeavyOpenAIFixture(options = {}) {
  const host = options.host ?? BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST;
  const port = options.port ?? BACKSTAGE_HEAVY_OPENAI_FIXTURE_PORT;
  if (host !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST) {
    throw new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST_INVALID');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_PORT_INVALID');
  }
  if (
    typeof options.expectedRunId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{7,63}$/u.test(options.expectedRunId)
  ) {
    throw new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUN_ID_INVALID');
  }

  const runtime = createBackstageHeavyOpenAIFixtureServer(options);
  await new Promise((resolve, reject) => {
    const handleError = () => reject(
      new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_LISTEN_FAILED')
    );
    runtime.server.once('error', handleError);
    runtime.server.listen(port, host, () => {
      runtime.server.off('error', handleError);
      resolve();
    });
  });

  return {
    ...runtime,
    close: () => new Promise((resolve, reject) => {
      runtime.server.close(error => {
        if (error) {
          reject(new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_CLOSE_FAILED'));
          return;
        }
        resolve();
      });
    }),
  };
}

// This opt-in profile extends the same loopback wire fixture. It is never
// selected by the compact-retry proof and cannot accept application credentials.
export const SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY =
  'sk-arcanos-self-heal-preview-protocol-v1';
export const SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CHILD_ARGUMENT = '--serve-self-heal-v1';
export const SELF_HEAL_PREVIEW_OPENAI_FIXTURE_READY_SENTINEL =
  'SELF_HEAL_PREVIEW_OPENAI_READY_V1';
export const SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH =
  '/__arcanos/self-heal-openai-fixture/control';
export const SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS = Object.freeze({
  maxLifetimeMs: 2 * 60 * 60 * 1000,
  maxRequestBytes: 128 * 1024,
  maxControlBytes: 1024,
  bodyTimeoutMs: 2000,
  maxDelayMs: 5000,
  maxProviderRequests: 128,
  maxControlRequests: 128,
});
export const SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS = Object.freeze([
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID, 'gpt-6.1-sol', 'gpt-6-luna',
]);
const SELF_HEAL_MODEL_IDS = new Set(SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS);
const SELF_HEAL_CHILD_ENV_NAMES = new Set([
  'NODE_ENV', 'TZ', BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUN_ID_ENV,
  'ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA',
  'ARCANOS_SELF_HEAL_PREVIEW_PROFILE', 'ARCANOS_SELF_HEAL_PREVIEW_RUN_ID',
  'ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT', 'ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT',
  'ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN',
  // libuv supplies these Windows identity/runtime names even when spawn receives
  // an explicit literal environment. No executable lookup uses them here.
  ...(process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER',
    'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME',
    'USERPROFILE', 'WINDIR'] : []),
]);
const SELF_HEAL_SYNTHETIC_OUTPUT =
  'Synthetic preview provider completed the isolated request.';
const SELF_HEAL_PREDICTIVE_OUTPUT = JSON.stringify({
  selectedCandidateIndex: 0, chooseNoAction: false,
  reason: 'Synthetic isolated preview selection of the first supplied candidate.',
  safeToExecute: true, confidence: 0.95,
});
const SELF_HEAL_PREDICTIVE_NO_ACTION_OUTPUT = JSON.stringify({
  selectedCandidateIndex: null, chooseNoAction: true,
  reason: 'Synthetic isolated preview found no supplied candidate.',
  safeToExecute: false, confidence: 0.95,
});
const SELF_HEAL_PREDICTIVE_OUTPUT_CONTRACT = 'Return JSON only with this schema: {"selectedCandidateIndex":number|null,"chooseNoAction":boolean,"reason":string,"safeToExecute":boolean,"confidence":number}';
const SELF_HEAL_CLEAR_OUTPUT = JSON.stringify({
  clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5,
});

function selfHealFixtureConfig(env, now) {
  const issuedAt = Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT);
  const expiresAt = Date.parse(env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT);
  const runId = env.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID;
  if (
    Object.keys(env).some(name => !SELF_HEAL_CHILD_ENV_NAMES.has(name)
      || typeof env[name] !== 'string')
    || env.NODE_ENV !== 'production' || env.TZ !== 'UTC'
    || env[BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV] !== 'v1'
    || env.ARCANOS_SELF_HEAL_PREVIEW_PROFILE !== 'worker-coordinator-v1'
    || typeof runId !== 'string' || !/^[a-z0-9][a-z0-9-]{7,63}$/u.test(runId)
    || env[BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUN_ID_ENV] !== runId
    || !/^[0-9a-f]{40}$/u.test(env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA ?? '')
    || !/^[0-9a-f]{64}$/u.test(env.ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN ?? '')
    || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt
    || expiresAt - issuedAt > SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxLifetimeMs
  ) throw new Error('SELF_HEAL_PREVIEW_OPENAI_CHILD_CONTRACT_INVALID');
  return {
    runId, issuedAt, expiresAt,
    sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA,
    controlToken: env.ARCANOS_SELF_HEAL_PREVIEW_CONTROL_TOKEN,
  };
}

function hasSelfHealControlAuthorization(request, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readSelfHealBoundedJson(request, maxBytes) {
  return new Promise(resolve => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onError);
      resolve(value);
    };
    const onData = chunk => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        request.pause();
        finish({ ok: false, status: 413, code: 'fixture_request_too_large' });
      } else chunks.push(buffer);
    };
    const onEnd = () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        finish(isRecord(body) ? { ok: true, body }
          : { ok: false, status: 400, code: 'fixture_request_invalid' });
      } catch { finish({ ok: false, status: 400, code: 'fixture_request_invalid' }); }
    };
    const onError = () => finish({ ok: false, status: 400, code: 'fixture_request_invalid' });
    const timer = setTimeout(() => {
      request.pause();
      finish({ ok: false, status: 408, code: 'fixture_body_timeout' });
    }, SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.bodyTimeoutMs);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onError);
  });
}

function exactSelfHealCommand(body, keys) {
  return Object.keys(body).length === keys.length
    && keys.every(key => Object.hasOwn(body, key));
}

function selfHealFixtureInputText(body, chat, userOnly = false) {
  const input = chat ? body.messages : body.input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input.flatMap(item => {
    if (!isRecord(item) || (userOnly && item.role !== 'user')) return [];
    if (typeof item.content === 'string') return [item.content];
    if (!Array.isArray(item.content)) return [];
    return item.content.filter(content => isRecord(content)
      && typeof content.text === 'string').map(content => content.text);
  }).join('\n');
}

function selfHealFixturePurpose(body, chat, runId) {
  const input = selfHealFixtureInputText(body, chat);
  if (input.includes('You are an expert auditor for AI reasoning.')
    && input.includes('Evaluate the following Reasoning Ledger based on the CLEAR principles.')
    && input.includes('Each score must be between 0 and 5.')) return 'clear-audit';
  if (input.includes('ARCANOS:CORE bounded production self-healing decision agent.')
    && input.includes('Select at most one provided self-healing candidate, or choose no action.')
    && input.includes(SELF_HEAL_PREDICTIVE_OUTPUT_CONTRACT)) return 'predictive-decision';
  const userInput = selfHealFixtureInputText(body, chat, true);
  const runMarkers = userInput.match(/\bRun [^\s.]+\./gu) ?? [];
  if (userInput.length >= 1200
    && userInput.split(BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL).length === 2
    && userInput.split(BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE).length === 2
    && runMarkers.length === 1
    && [1, 2].some(attempt => runMarkers[0] === `Run ${runId}-web-${attempt}.`)) {
    return 'backstage-web-completion';
  }
  return 'synthetic-completion';
}

function selfHealPredictiveOutput(body, chat) {
  const lines = selfHealFixtureInputText(body, chat).split(/\r?\n/u)
    .filter(line => line.startsWith('Candidates='));
  if (lines.length !== 1) return SELF_HEAL_PREDICTIVE_NO_ACTION_OUTPUT;
  try {
    const candidates = JSON.parse(lines[0].slice('Candidates='.length));
    return Array.isArray(candidates) && candidates.length > 0 && candidates.length <= 5
      && candidates.every((candidate, index) => isRecord(candidate) && candidate.index === index)
      ? SELF_HEAL_PREDICTIVE_OUTPUT : SELF_HEAL_PREDICTIVE_NO_ACTION_OUTPUT;
  } catch { return SELF_HEAL_PREDICTIVE_NO_ACTION_OUTPUT; }
}

function selfHealFixtureOutput(body, chat, purpose) {
  const answer = purpose === 'clear-audit' ? SELF_HEAL_CLEAR_OUTPUT
    : purpose === 'predictive-decision' ? selfHealPredictiveOutput(body, chat)
      : purpose === 'backstage-web-completion' ? BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT
        : SELF_HEAL_SYNTHETIC_OUTPUT;
  const format = chat ? body.response_format?.json_schema : body.text?.format;
  if (!format || format.type === 'text'
    || (format.type === 'json_object'
      && (purpose === 'clear-audit' || purpose === 'predictive-decision'))) return answer;
  const name = format.name;
  if (name !== 'trinity_structured_reasoning'
    && name !== 'trinity_structured_reasoning_compact') return null;
  const result = {
    response_mode: 'answer', achievable_subtasks: [], blocked_subtasks: [],
    user_visible_caveats: ['Synthetic isolated preview evidence.'],
    claim_tags: [], final_answer: answer,
  };
  if (name === 'trinity_structured_reasoning') Object.assign(result, {
    reasoning_steps: [], assumptions: [], constraints: [], tradeoffs: [],
    alternatives_considered: [],
    chosen_path_justification: 'Use only the fixed synthetic preview response.',
  });
  return JSON.stringify(result);
}

/** Bounded provider effects are visible through independently read receipts. */
export async function startSelfHealPreviewOpenAIFixture(options = {}) {
  const now = options.now ?? Date.now;
  const config = selfHealFixtureConfig(options.env ?? process.env, now());
  const host = options.host ?? BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST;
  const port = options.port ?? BACKSTAGE_HEAVY_OPENAI_FIXTURE_PORT;
  if (host !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_HOST
    || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('SELF_HEAL_PREVIEW_OPENAI_LISTEN_TARGET_INVALID');
  }
  const state = {
    ready: true, expired: false, providerRequests: 0, controlRequests: 0,
    completed: 0, timedOut: 0, clientClosed: 0, rejected: 0,
    inFlight: null, nextFault: null, receipts: [],
  };
  let active = null;
  let closePromise = null;
  let expiryTimer;
  const inspect = () => ({
    schemaVersion: 1, profile: 'worker-coordinator-v1', runId: config.runId,
    sourceSha: config.sourceSha, issuedAt: config.issuedAt, expiresAt: config.expiresAt,
    ready: state.ready, expired: state.expired,
    providerRequests: state.providerRequests, controlRequests: state.controlRequests,
    completed: state.completed, timedOut: state.timedOut,
    clientClosed: state.clientClosed, rejected: state.rejected,
    inFlight: state.inFlight,
    nextFault: state.nextFault ? { ...state.nextFault } : null,
    receipts: state.receipts.map(receipt => ({ ...receipt })),
    limits: SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS,
  });
  const server = createServer(async (request, response) => {
    response.setHeader('connection', 'close');
    const url = parseRequestUrl(request);
    const isControl = url?.pathname === SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CONTROL_PATH;
    // The purpose token cannot authorize provider calls and the fictional SDK
    // key cannot inspect or mutate fault state. Authenticate before body reads.
    if (!(isControl ? hasSelfHealControlAuthorization(request, config.controlToken)
      : hasFixtureAuthorization(request, SELF_HEAL_PREVIEW_OPENAI_FIXTURE_SDK_KEY))) {
      state.rejected += 1;
      writeOpenAIError(response, 401, 'fixture_authorization_required');
      return;
    }
    if (!state.ready || now() >= config.expiresAt) {
      writeOpenAIError(response, 410, 'fixture_expired');
      return;
    }
    if (!url || !hasNoQuery(url)) {
      state.rejected += 1;
      writeOpenAIError(response, 404, 'fixture_route_not_found');
      return;
    }
    if (isControl) {
      state.controlRequests += 1;
      if (state.controlRequests > SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxControlRequests) {
        writeOpenAIError(response, 429, 'fixture_request_limit'); return;
      }
      if (request.method !== 'POST') {
        writeOpenAIError(response, 405, 'fixture_method_invalid'); return;
      }
      if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) {
        writeOpenAIError(response, 415, 'fixture_content_type_invalid'); return;
      }
      const parsed = await readSelfHealBoundedJson(request,
        SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxControlBytes);
      if (!parsed.ok) { writeOpenAIError(response, parsed.status, parsed.code); return; }
      if (!state.ready) { writeOpenAIError(response, 410, 'fixture_expired'); return; }
      const body = parsed.body;
      if (['inspect', 'set_healthy', 'release'].includes(body.command)
        && exactSelfHealCommand(body, ['command'])) {
        if (body.command === 'set_healthy') state.nextFault = null;
        if (body.command === 'set_healthy' || body.command === 'release') active?.release();
        writeJson(response, 200, inspect()); return;
      }
      const timeout = body.command === 'timeout_next';
      const hold = body.command === 'hold_next';
      if ((!timeout && !hold)
        || !exactSelfHealCommand(body, timeout ? ['command', 'count', 'delayMs'] : ['command', 'delayMs'])
        || !Number.isInteger(body.delayMs) || body.delayMs < 1
        || body.delayMs > SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxDelayMs
        || (timeout && (!Number.isInteger(body.count) || body.count < 1 || body.count > 4))) {
        writeOpenAIError(response, 422, 'fixture_control_invalid'); return;
      }
      if (state.inFlight || state.nextFault) {
        writeOpenAIError(response, 409, 'fixture_fault_already_active'); return;
      }
      state.nextFault = { kind: timeout ? 'timeout' : 'hold', remaining: timeout ? body.count : 1,
        delayMs: body.delayMs };
      writeJson(response, 200, inspect()); return;
    }
    const modelsList = request.method === 'GET' && url.pathname === '/v1/models';
    // Cold production clients retrieve a model before their first completion.
    // Match only literal server-owned identities, including the SDK's encoding.
    const retrievedModel = request.method === 'GET'
      ? SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS.find(id => url.pathname === `/v1/models/${id}`
        || url.pathname === `/v1/models/${encodeURIComponent(id)}`) : undefined;
    const models = modelsList || retrievedModel !== undefined;
    const chat = request.method === 'POST' && url.pathname === '/v1/chat/completions';
    const responses = request.method === 'POST' && url.pathname === '/v1/responses';
    if (!models && !chat && !responses) {
      state.rejected += 1;
      writeOpenAIError(response, 404, 'fixture_route_not_found'); return;
    }
    if (state.providerRequests >= SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxProviderRequests) {
      writeOpenAIError(response, 429, 'fixture_request_limit'); return;
    }
    if (state.inFlight) {
      state.rejected += 1;
      writeOpenAIError(response, 429, 'fixture_request_in_flight'); return;
    }
    const requestId = `self-heal-fixture-${++state.providerRequests}`;
    const receipt = { requestId, endpoint: models ? 'models' : chat ? 'chat' : 'responses',
      startedAt: now(), endedAt: null, outcome: 'in_flight' };
    state.receipts.push(receipt);
    state.inFlight = requestId;
    response.setHeader('x-request-id', requestId);
    let settled = false;
    let delayTimer;
    const finish = (outcome, code, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(delayTimer);
      response.off('close', onClose);
      receipt.endedAt = now(); receipt.outcome = outcome;
      state.inFlight = null; active = null;
      if (outcome === 'completed') state.completed += 1;
      if (outcome === 'timeout') state.timedOut += 1;
      if (outcome === 'client_closed') state.clientClosed += 1;
      if (body && !response.destroyed) writeJson(response, code, body);
    };
    const onClose = () => finish('client_closed');
    response.once('close', onClose);
    const reject = (code, errorCode) => finish('rejected', code, { error: {
      code: errorCode, message: 'The isolated preview fixture rejected this request.',
      type: 'invalid_request_error',
    } });
    try {
      let body;
      let output;
      if (!models) {
        if (!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')) {
          reject(415, 'fixture_content_type_invalid'); return;
        }
        const parsed = await readSelfHealBoundedJson(request,
          SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.maxRequestBytes);
        if (settled) return;
        if (!parsed.ok) { reject(parsed.status, parsed.code); return; }
        if (!state.ready || now() >= config.expiresAt) { reject(410, 'fixture_expired'); return; }
        body = parsed.body;
        const purpose = selfHealFixturePurpose(body, chat, config.runId);
        output = selfHealFixtureOutput(body, chat, purpose);
        if (!SELF_HEAL_MODEL_IDS.has(body.model)
          || body.stream === true || output === null
          || (chat ? !Array.isArray(body.messages) || body.messages.length === 0
            : !(typeof body.input === 'string' || Array.isArray(body.input)))) {
          reject(422, 'fixture_provider_contract_invalid'); return;
        }
        receipt.model = body.model;
        receipt.purpose = purpose;
      }
      const success = () => finish('completed', 200, retrievedModel !== undefined ? {
        id: retrievedModel, object: 'model', created: 0, owned_by: 'arcanos-preview-fixture',
      } : modelsList ? {
        object: 'list', data: SELF_HEAL_PREVIEW_OPENAI_FIXTURE_MODEL_IDS.map(id => ({ id,
          object: 'model', created: 0, owned_by: 'arcanos-preview-fixture' })),
      } : chat ? {
        id: `chatcmpl_${requestId}`, object: 'chat.completion', created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: output, refusal: null },
          finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 64, completion_tokens: 32, total_tokens: 96 },
      } : buildResponseWireBody({ callNumber: state.providerRequests,
        model: body.model, status: 'completed', text: output }));
      active = { release: success, stop: () => {
        finish('shutdown', 503, { error: { code: 'fixture_stopped',
          message: 'The isolated preview fixture has stopped.', type: 'server_error' } });
      } };
      const fault = state.nextFault;
      if (!fault) { success(); return; }
      state.nextFault = fault.remaining > 1 ? { ...fault, remaining: fault.remaining - 1 } : null;
      receipt.fault = fault.kind;
      delayTimer = setTimeout(() => finish('timeout', 504, { error: {
        code: 'fixture_provider_timeout', message: 'The isolated preview provider timed out.',
        type: 'server_error',
      } }), fault.delayMs);
    } catch { reject(400, 'fixture_request_invalid'); }
  });
  server.headersTimeout = 3000;
  server.requestTimeout = 10_000;
  server.maxConnections = 8;
  const close = () => {
    if (closePromise) return closePromise;
    state.ready = false; state.nextFault = null;
    clearTimeout(expiryTimer);
    active?.stop();
    closePromise = new Promise((resolve, reject) => {
      server.close(error => error
        ? reject(new Error('SELF_HEAL_PREVIEW_OPENAI_CLOSE_FAILED')) : resolve());
      // Headers/body readers have a two-second deadline. Close any remaining
      // sockets after it so expiry cannot strand an incomplete upload.
      const drainTimer = setTimeout(() => server.closeAllConnections(),
        SELF_HEAL_PREVIEW_OPENAI_FIXTURE_LIMITS.bodyTimeoutMs + 50);
      drainTimer.unref?.();
      server.once('close', () => clearTimeout(drainTimer));
    });
    return closePromise;
  };
  await new Promise((resolve, reject) => {
    server.once('error', () => reject(new Error('SELF_HEAL_PREVIEW_OPENAI_LISTEN_FAILED')));
    server.listen(port, host, resolve);
  });
  expiryTimer = setTimeout(() => {
    state.expired = true;
    close().catch(() => server.closeAllConnections());
  }, Math.max(1, config.expiresAt - now()));
  expiryTimer.unref?.();
  return { server, state, inspect, close };
}

async function runFixtureChild() {
  const runId = process.env[
    BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUN_ID_ENV
  ];
  if (
    process.argv.length !== 3
    || process.argv[2] !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ARGUMENT
    || process.env[BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_ENV]
      !== BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_VALUE
    || typeof runId !== 'string'
    || !/^[a-z0-9][a-z0-9-]{7,63}$/u.test(runId)
    || Object.keys(process.env).some(name => /(?:OPENAI|API)_KEY/iu.test(name))
  ) {
    throw new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_CHILD_CONTRACT_INVALID');
  }

  const runtime = await startBackstageHeavyOpenAIFixture({
    expectedRunId: runId,
  });
  process.stdout.write(`${BACKSTAGE_HEAVY_OPENAI_FIXTURE_READY_SENTINEL}\n`);

  await new Promise((resolve, reject) => {
    let shutdownStarted = false;
    const cleanup = () => {
      runtime.server.off('error', handleRuntimeError);
      process.off('SIGTERM', handleSigterm);
      process.off('SIGINT', handleSigint);
    };
    const handleRuntimeError = () => {
      cleanup();
      reject(new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_RUNTIME_FAILED'));
    };
    const shutdown = () => {
      if (shutdownStarted) {
        return;
      }
      shutdownStarted = true;
      runtime.close().then(() => {
        cleanup();
        resolve();
      }).catch(() => {
        cleanup();
        reject(new Error('BACKSTAGE_HEAVY_OPENAI_FIXTURE_CLOSE_FAILED'));
      });
    };
    const handleSigterm = () => shutdown();
    const handleSigint = () => shutdown();
    runtime.server.once('error', handleRuntimeError);
    process.once('SIGTERM', handleSigterm);
    process.once('SIGINT', handleSigint);
  });
}

async function runSelfHealFixtureChild() {
  if (process.argv.length !== 3
    || process.argv[2] !== SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CHILD_ARGUMENT) {
    throw new Error('SELF_HEAL_PREVIEW_OPENAI_CHILD_CONTRACT_INVALID');
  }
  const runtime = await startSelfHealPreviewOpenAIFixture();
  process.stdout.write(`${SELF_HEAL_PREVIEW_OPENAI_FIXTURE_READY_SENTINEL}\n`);
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
      runtime.server.off('error', onError);
    };
    const shutdown = () => runtime.close().catch(onError);
    const onError = () => {
      cleanup(); reject(new Error('SELF_HEAL_PREVIEW_OPENAI_RUNTIME_FAILED'));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    runtime.server.once('error', onError);
    runtime.server.once('close', () => { cleanup(); resolve(); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.argv[2] === SELF_HEAL_PREVIEW_OPENAI_FIXTURE_CHILD_ARGUMENT
    ? runSelfHealFixtureChild() : runFixtureChild()).catch(error => {
    const code = error instanceof Error
      ? error.message
      : 'BACKSTAGE_HEAVY_OPENAI_FIXTURE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
