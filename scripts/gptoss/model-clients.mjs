import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { OPENAI_REFERENCE_MODEL } from './bridge-policy.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;

export function readBridgeConfig(env = process.env) {
  return {
    openaiReferenceModel: env.OPENAI_REFERENCE_MODEL || OPENAI_REFERENCE_MODEL,
    openaiApiKeyPresent: Boolean(env.OPENAI_API_KEY?.trim()),
    gptossApiBaseUrl: env.GPTOSS_API_BASE_URL || 'http://127.0.0.1:8000/v1',
    gptossModel: env.GPTOSS_MODEL || 'openai/gpt-oss-20b',
    referenceRole: env.ARCANOS_REFERENCE_MODEL_ROLE || 'evaluate_only',
  };
}

export function buildChatPayload({ model, prompt }) {
  return {
    model,
    messages: [
      {
        role: 'system',
        content:
          'You are participating in an Arcanos migration QA comparison. Answer only the user task. Do not reveal hidden reasoning.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
  };
}

export async function postOpenAiCompatibleChat({
  baseUrl,
  apiKey,
  model,
  prompt,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const startedAt = performance.now();
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey || 'not-needed'}`,
      },
      body: JSON.stringify(buildChatPayload({ model, prompt })),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        status: 'error',
        latencyMs,
        errorClass: `http_${response.status}`,
      };
    }

    return {
      status: 'ok',
      latencyMs,
      output: extractOpenAiText(body),
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: null,
      errorClass: error?.name === 'AbortError' ? 'timeout' : 'endpoint_unavailable',
      errorMessage: error instanceof Error ? error.message : String(error),
      baseUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function extractOpenAiText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('');
  }

  return '';
}

export async function callCandidate({ prompt, config = readBridgeConfig(), fetchImpl = globalThis.fetch }) {
  return postOpenAiCompatibleChat({
    baseUrl: config.gptossApiBaseUrl,
    apiKey: 'local-gptoss',
    model: config.gptossModel,
    prompt,
    fetchImpl,
  });
}

export async function callReference({ prompt, config = readBridgeConfig(), fetchImpl = globalThis.fetch }) {
  if (!config.openaiApiKeyPresent) {
    return {
      status: 'skipped',
      latencyMs: null,
      errorClass: 'missing_openai_api_key',
    };
  }

  return postOpenAiCompatibleChat({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: process.env.OPENAI_API_KEY,
    model: config.openaiReferenceModel,
    prompt,
    fetchImpl,
  });
}

export async function checkLocalGptossHealth({
  config = readBridgeConfig(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 'error', errorClass: 'fetch_unavailable' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${config.gptossApiBaseUrl.replace(/\/$/, '')}/models`, {
      signal: controller.signal,
      headers: { authorization: 'Bearer local-gptoss' },
    });

    return {
      ok: response.ok,
      status: response.ok ? 'ok' : 'error',
      statusCode: response.status,
      baseUrl: config.gptossApiBaseUrl,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'error',
      errorClass: error?.name === 'AbortError' ? 'timeout' : 'endpoint_unavailable',
      baseUrl: config.gptossApiBaseUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}
