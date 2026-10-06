/** Application egress policy. This module does not configure a platform network ACL. */
export const LIVE_VALIDATION_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const LIVE_VALIDATION_MODEL_URL_PREFIX = 'https://api.openai.com/v1/models/';
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const REQUEST_KEYS = new Set(['model', 'input', 'instructions', 'max_output_tokens', 'temperature', 'top_p',
  'reasoning', 'text', 'metadata', 'store', 'stream', 'truncation', 'service_tier', 'parallel_tool_calls']);
const RESPONSE_LIMIT = 1024 * 1024;
const REQUEST_LIMIT = 4_000_000;
const INTERNAL_HOSTS = ['localhost', 'local', 'internal', 'railway.internal'];

export class LiveValidationEgressError extends Error {
  constructor(code) { super(code); this.name = 'LiveValidationEgressError'; this.code = code; }
}
function requireEgress(condition, code) { if (!condition) throw new LiveValidationEgressError(code); }

function approvedModelIds(approvedModels) {
  requireEgress(Array.isArray(approvedModels) && approvedModels.length > 0 && approvedModels.length <= 64,
    'LIVE_VALIDATION_MODELS_INVALID');
  const ids = approvedModels.map(model => typeof model === 'string' ? model : model?.id);
  requireEgress(ids.every(id => typeof id === 'string' && MODEL_ID.test(id)) && new Set(ids).size === ids.length,
    'LIVE_VALIDATION_MODELS_INVALID');
  return new Set(ids);
}

// Inspect data descriptors instead of invoking getters/toJSON at the transport boundary.
function safeJson(value, depth = 0) {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 1_025 || keys.some(key => typeof key !== 'string')) return false;
  if (Array.isArray(value) && (value.length > 1_024 || keys.length !== value.length + 1
    || !Array.from({ length: value.length }, (_, index) => String(index)).every(key => Object.hasOwn(descriptors, key)))) return false;
  return keys.every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = descriptors[key];
    return descriptor.enumerable && Object.hasOwn(descriptor, 'value')
      && !['__proto__', 'prototype', 'constructor'].includes(key) && safeJson(descriptor.value, depth + 1);
  });
}

function textualContent(value) {
  return typeof value === 'string' || (Array.isArray(value) && value.length > 0 && value.length <= 128
    && value.every(item => item && typeof item === 'object' && Object.keys(item).length === 2
      && ['input_text', 'output_text'].includes(item.type) && typeof item.text === 'string'));
}
function textualInput(value) {
  return typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0 && value.length <= 128
    && value.every(item => item && typeof item === 'object'
      && Object.keys(item).every(key => ['role', 'content', 'type'].includes(key))
      && (item.type === undefined || item.type === 'message')
      && ['system', 'developer', 'user', 'assistant'].includes(item.role) && textualContent(item.content));
}

/** Budget/pricing and response semantics remain the process-local paid guard's responsibility. */
export function validateLiveValidationProviderRequest({ url, method = 'POST', body } = {}, { approvedModels } = {}) {
  const models = approvedModelIds(approvedModels);
  requireEgress(typeof url === 'string', 'LIVE_VALIDATION_PROVIDER_URL_FORBIDDEN');
  if (method === 'GET') {
    let id;
    try { id = decodeURIComponent(url.slice(LIVE_VALIDATION_MODEL_URL_PREFIX.length)); }
    catch { /* A malformed or alternate encoding is forbidden. */ }
    requireEgress(typeof id === 'string' && models.has(id)
      && url === LIVE_VALIDATION_MODEL_URL_PREFIX + encodeURIComponent(id), 'LIVE_VALIDATION_PROVIDER_URL_FORBIDDEN');
    requireEgress(body === undefined, 'LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN');
  } else {
    requireEgress(method === 'POST' && url === LIVE_VALIDATION_RESPONSES_URL, 'LIVE_VALIDATION_PROVIDER_URL_FORBIDDEN');
    // Closed textual payloads cannot request tools, remote media or endpoint overrides.
    requireEgress(safeJson(body) && body && !Array.isArray(body)
      && Object.keys(body).every(key => REQUEST_KEYS.has(key)) && models.has(body.model) && textualInput(body.input)
      && (body.stream === undefined || body.stream === false)
      && (body.store === undefined || body.store === false)
      && (body.parallel_tool_calls === undefined || body.parallel_tool_calls === false),
    'LIVE_VALIDATION_PROVIDER_PAYLOAD_FORBIDDEN');
    requireEgress(Buffer.byteLength(JSON.stringify(body), 'utf8') <= REQUEST_LIMIT,
      'LIVE_VALIDATION_PROVIDER_REQUEST_LIMIT');
  }
  return Object.freeze({ url, method });
}

function providerHeaders(input, method) {
  let headers;
  try { headers = new Headers(input); }
  catch { throw new LiveValidationEgressError('LIVE_VALIDATION_PROVIDER_HEADERS_FORBIDDEN'); }
  requireEgress([...headers.keys()].every(key => ['authorization', 'content-type', 'accept'].includes(key))
    && /^Bearer [^\s]+$/u.test(headers.get('authorization') ?? ''), 'LIVE_VALIDATION_PROVIDER_HEADERS_FORBIDDEN');
  return { authorization: headers.get('authorization'), accept: 'application/json',
    ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) };
}

/** One call, fixed init options, default public TLS verification, no redirects or retries. */
export function createLiveValidationProviderTransport({ approvedModels, fetchImplementation = globalThis.fetch } = {}) {
  const models = [...approvedModelIds(approvedModels)];
  requireEgress(typeof fetchImplementation === 'function', 'LIVE_VALIDATION_PROVIDER_TRANSPORT_INVALID');
  return async ({ url, method = 'POST', headers, body, signal } = {}) => {
    validateLiveValidationProviderRequest({ url, method, body }, { approvedModels: models });
    const requestHeaders = providerHeaders(headers, method);
    requireEgress(!signal?.aborted, 'LIVE_VALIDATION_PROVIDER_CANCELLED');
    let abortHandler; let iterator; let complete = false;
    const interrupted = new Promise((_, reject) => {
      abortHandler = () => reject(new LiveValidationEgressError('LIVE_VALIDATION_PROVIDER_CANCELLED'));
      signal?.addEventListener('abort', abortHandler, { once: true });
    });
    try {
      // The paid guard's deadline also bounds transports and body readers that ignore AbortSignal.
      const result = await Promise.race([fetchImplementation(url, { method, headers: requestHeaders,
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error' }), interrupted]);
      requireEgress(result && !result.redirected && result.status >= 200 && result.status < 300,
        'LIVE_VALIDATION_PROVIDER_FAILED');
      requireEgress(result.body && typeof result.body[Symbol.asyncIterator] === 'function',
        'LIVE_VALIDATION_PROVIDER_RESPONSE_INVALID');
      iterator = result.body[Symbol.asyncIterator]();
      const chunks = []; let bytes = 0;
      while (true) {
        const item = await Promise.race([iterator.next(), interrupted]);
        if (item.done) { complete = true; break; }
        requireEgress(item.value instanceof Uint8Array, 'LIVE_VALIDATION_PROVIDER_RESPONSE_INVALID');
        bytes += item.value.byteLength;
        requireEgress(bytes <= RESPONSE_LIMIT, 'LIVE_VALIDATION_PROVIDER_RESPONSE_LIMIT');
        chunks.push(Buffer.from(item.value));
      }
      let parsed;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new LiveValidationEgressError('LIVE_VALIDATION_PROVIDER_RESPONSE_INVALID'); }
      return { status: result.status, body: parsed };
    } finally {
      signal?.removeEventListener('abort', abortHandler);
      // A reader ignoring cancellation must not delay the paid guard's timeout result.
      if (!complete && typeof iterator?.return === 'function') {
        try { Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Best-effort stream cancellation. */ }
      }
    }
  };
}

function canonicalHostname(hostname) { return hostname.toLowerCase().replace(/\.$/u, ''); }
function parseSourceUrl(rawUrl, code) {
  requireEgress(typeof rawUrl === 'string' && rawUrl.length > 0 && rawUrl.length <= 4_096 && rawUrl === rawUrl.trim(), code);
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new LiveValidationEgressError(code); }
  requireEgress(parsed.protocol === 'https:' && !parsed.username && !parsed.password
    && (!parsed.port || parsed.port === '443') && parsed.hostname, code);
  return parsed;
}
function sourcePolicy({ forbiddenOrigins = [], forbiddenHostnames = [] } = {}) {
  requireEgress(Array.isArray(forbiddenOrigins) && Array.isArray(forbiddenHostnames)
    && forbiddenOrigins.length <= 128 && forbiddenHostnames.length <= 128, 'LIVE_VALIDATION_SOURCE_POLICY_INVALID');
  const origins = new Set(forbiddenOrigins.map(origin => {
    const parsed = parseSourceUrl(origin, 'LIVE_VALIDATION_SOURCE_POLICY_INVALID');
    requireEgress(parsed.pathname === '/' && !parsed.search && !parsed.hash, 'LIVE_VALIDATION_SOURCE_POLICY_INVALID');
    // Ignore an insignificant trailing DNS dot when matching configured origins.
    parsed.hostname = canonicalHostname(parsed.hostname);
    return parsed.origin;
  }));
  const hostnames = [...INTERNAL_HOSTS, 'api.openai.com', ...forbiddenHostnames.map(hostname => {
    requireEgress(typeof hostname === 'string' && hostname.length > 0 && hostname === hostname.trim(),
      'LIVE_VALIDATION_SOURCE_POLICY_INVALID');
    const parsed = parseSourceUrl('https://' + hostname, 'LIVE_VALIDATION_SOURCE_POLICY_INVALID');
    requireEgress(parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.port
      && canonicalHostname(parsed.hostname) === canonicalHostname(hostname), 'LIVE_VALIDATION_SOURCE_POLICY_INVALID');
    return canonicalHostname(parsed.hostname);
  })];
  return { origins, hostnames };
}
function assertSourceUrl(rawUrl, policy) {
  const parsed = parseSourceUrl(rawUrl, 'LIVE_VALIDATION_SOURCE_URL_FORBIDDEN');
  parsed.hostname = canonicalHostname(parsed.hostname);
  requireEgress(!policy.origins.has(parsed.origin)
    && !policy.hostnames.some(hostname => parsed.hostname === hostname || parsed.hostname.endsWith('.' + hostname)),
  'LIVE_VALIDATION_SOURCE_URL_FORBIDDEN');
  return parsed.href;
}

/** Preflight only: run on every hop through the existing DNS/IP-pinned SSRF-safe source transport. */
export function assertRuntimeSourceEgressUrl(rawUrl, policy = {}) {
  return assertSourceUrl(rawUrl, sourcePolicy(policy));
}
export function createLiveValidationSourceGuard(policy = {}) {
  const compiled = sourcePolicy(policy);
  return rawUrl => assertSourceUrl(rawUrl, compiled);
}

export function getLiveValidationEgressPolicySummary() {
  return Object.freeze({ enforcement: 'application', platformDomainAcl: false,
    provider: Object.freeze({ origin: 'https://api.openai.com', responseMethod: 'POST', metadataMethod: 'GET',
      approvedModelsOnly: true, redirects: false, retries: 0, tls: 'default-public-verification' }),
    runtimeSources: Object.freeze({ publisherAllowlist: false, requiresProtectedSourceTransport: true,
      guardEveryRedirectHop: true, dnsAndIpPinning: 'existing-protected-source-transport',
      scope: 'configured destination denials supplement existing SSRF guards' }) });
}
