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
export const BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID = 'gpt-5.1';
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

function hasFixtureAuthorization(request) {
  return request.headers.authorization
    === `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFixtureChild().catch(error => {
    const code = error instanceof Error
      ? error.message
      : 'BACKSTAGE_HEAVY_OPENAI_FIXTURE_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
