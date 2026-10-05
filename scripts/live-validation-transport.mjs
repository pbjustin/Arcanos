import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, request as httpsRequest } from 'node:https';
import path from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_TLS_FILE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const PRIVATE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.railway\.internal$/u;

export class LiveValidationTransportError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function requireTransport(condition, code) {
  if (!condition) throw new LiveValidationTransportError(code);
}

/** Syntax validation is not admission: callers must supply the one signed, approved origin. */
export function validateLiveValidationPrivateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new LiveValidationTransportError('LIVE_VALIDATION_PRIVATE_ORIGIN_INVALID'); }
  requireTransport(typeof value === 'string' && value === url.origin && url.protocol === 'https:'
    && PRIVATE_HOST.test(url.hostname) && url.port === '8443' && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash, 'LIVE_VALIDATION_PRIVATE_ORIGIN_INVALID');
  return url.origin;
}

function fingerprint(value) {
  requireTransport(typeof value === 'string' && (/^[0-9a-f]{64}$/u.test(value)
    || /^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/u.test(value)), 'LIVE_VALIDATION_TLS_IDENTITY_INVALID');
  return value.replaceAll(':', '').toLowerCase();
}

function identity(value, roles) {
  requireTransport(value && typeof value === 'object' && PRIVATE_HOST.test(value.dnsName)
    && (roles ? roles.includes(value.role) : value.role === undefined || ['supervisor', 'runtime'].includes(value.role)),
  'LIVE_VALIDATION_TLS_IDENTITY_INVALID');
  return Object.freeze({ ...(value.role === undefined ? {} : { role: value.role }), dnsName: value.dnsName,
    fingerprintSha256: fingerprint(value.fingerprintSha256) });
}

function sameFingerprint(left, right) {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function matchesPeer(certificate, expected) {
  try {
    if (!certificate?.raw) return false;
    const actual = createHash('sha256').update(certificate.raw).digest('hex');
    return sameFingerprint(actual, expected.fingerprintSha256)
      && new X509Certificate(certificate.raw).checkHost(expected.dnsName,
        { subject: 'never', wildcards: false, partialWildcards: false }) === expected.dnsName;
  } catch { return false; }
}

function protectedStat(stat, directory = false) {
  requireTransport(typeof process.getuid === 'function' && stat.uid === process.getuid()
    && (directory ? stat.isDirectory() : stat.isFile()) && (stat.mode & 0o077) === 0,
  'LIVE_VALIDATION_TLS_FILE_UNSAFE');
}

/** Key material comes only from owner-only operator files outside the source checkout. */
export function readLiveValidationTlsFiles({ caFile, certFile, keyFile } = {}, repositoryRoot = REPOSITORY_ROOT) {
  const root = realpathSync(repositoryRoot);
  const read = file => {
    requireTransport(typeof file === 'string' && path.isAbsolute(file), 'LIVE_VALIDATION_TLS_FILE_UNSAFE');
    try {
      const directory = path.dirname(file);
      requireTransport(!lstatSync(directory).isSymbolicLink() && !lstatSync(file).isSymbolicLink(),
        'LIVE_VALIDATION_TLS_FILE_UNSAFE');
      protectedStat(lstatSync(directory), true);
      const resolved = realpathSync(file);
      const relative = path.relative(root, resolved);
      requireTransport(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'LIVE_VALIDATION_TLS_FILE_UNSAFE');
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(descriptor);
        protectedStat(stat);
        requireTransport(stat.size > 0 && stat.size <= MAX_TLS_FILE_BYTES, 'LIVE_VALIDATION_TLS_FILE_UNSAFE');
        return readFileSync(descriptor);
      } finally { closeSync(descriptor); }
    } catch { throw new LiveValidationTransportError('LIVE_VALIDATION_TLS_FILE_UNSAFE'); }
  };
  return Object.freeze({ ca: read(caFile), cert: read(certFile), key: read(keyFile) });
}

function bound(value, maximum, code) {
  requireTransport(Number.isSafeInteger(value) && value > 0 && value <= maximum, code);
  return value;
}

function requestUrl(input, origin) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : input); }
  catch { throw new LiveValidationTransportError('LIVE_VALIDATION_PRIVATE_URL_FORBIDDEN'); }
  requireTransport(url.origin === origin && !url.username && !url.password && !url.hash,
    'LIVE_VALIDATION_PRIVATE_URL_FORBIDDEN');
  return url;
}

function requestHeaders(input) {
  const headers = new Headers(input);
  for (const header of ['host', 'connection', 'proxy-authorization', 'proxy-connection', 'transfer-encoding',
    'content-length', 'upgrade']) {
    requireTransport(!headers.has(header), 'LIVE_VALIDATION_PRIVATE_HEADER_FORBIDDEN');
  }
  return Object.fromEntries(headers);
}

async function requestBody(body, maxBytes, abortSignal) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) {
    const bytes = Buffer.from(body);
    requireTransport(bytes.length <= maxBytes, 'LIVE_VALIDATION_REQUEST_LIMIT');
    return bytes;
  }
  // Fetch Request bodies are streams. Read them incrementally with the same absolute deadline.
  requireTransport(typeof body.getReader === 'function', 'LIVE_VALIDATION_REQUEST_BODY_INVALID');
  const reader = body.getReader();
  const chunks = []; let bytes = 0;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  abortSignal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (abortSignal.aborted) throw new LiveValidationTransportError('LIVE_VALIDATION_REQUEST_ABORTED');
      const chunk = await reader.read();
      if (abortSignal.aborted) throw new LiveValidationTransportError('LIVE_VALIDATION_REQUEST_ABORTED');
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      requireTransport(bytes <= maxBytes, 'LIVE_VALIDATION_REQUEST_LIMIT');
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks);
  } finally {
    abortSignal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** No ambient CA override, retry, proxy, redirect, or second destination exists in this client. */
export function createLiveValidationPrivateClient({ origin, serverIdentity, tlsFiles,
  timeoutMs = MAX_TIMEOUT_MS, maxRequestBytes = MAX_REQUEST_BYTES, maxResponseBytes = MAX_RESPONSE_BYTES,
  repositoryRoot = REPOSITORY_ROOT, requestImplementation = httpsRequest } = {}) {
  origin = validateLiveValidationPrivateOrigin(origin);
  const peer = identity(serverIdentity);
  requireTransport(peer.dnsName === new URL(origin).hostname, 'LIVE_VALIDATION_TLS_IDENTITY_INVALID');
  const tls = readLiveValidationTlsFiles(tlsFiles, repositoryRoot);
  bound(timeoutMs, MAX_TIMEOUT_MS, 'LIVE_VALIDATION_REQUEST_DEADLINE_INVALID');
  bound(maxRequestBytes, MAX_REQUEST_BYTES, 'LIVE_VALIDATION_REQUEST_LIMIT_INVALID');
  bound(maxResponseBytes, MAX_RESPONSE_BYTES, 'LIVE_VALIDATION_RESPONSE_LIMIT_INVALID');
  requireTransport(typeof requestImplementation === 'function', 'LIVE_VALIDATION_TRANSPORT_INVALID');

  const fetch = async (input, init = {}) => {
    // Reject a public destination before handling any caller bearer, body or TLS request.
    const url = requestUrl(input, origin);
    const source = input instanceof Request ? input : undefined;
    const method = (init.method ?? source?.method ?? 'GET').toUpperCase();
    requireTransport(['GET', 'POST', 'DELETE'].includes(method), 'LIVE_VALIDATION_PRIVATE_METHOD_FORBIDDEN');
    requireTransport(init.redirect === undefined || init.redirect === 'error', 'LIVE_VALIDATION_REDIRECT_FORBIDDEN');
    const headers = requestHeaders(init.headers ?? source?.headers);
    const requestTimeout = bound(init.timeoutMs ?? timeoutMs, timeoutMs, 'LIVE_VALIDATION_REQUEST_DEADLINE_INVALID');
    const callerSignal = init.signal ?? source?.signal;
    const controller = new AbortController();
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    if (callerSignal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeout);
    try {
      const body = await requestBody(init.body ?? source?.body, maxRequestBytes, controller.signal);
      requireTransport(!controller.signal.aborted, timedOut ? 'LIVE_VALIDATION_REQUEST_TIMEOUT' : 'LIVE_VALIDATION_REQUEST_ABORTED');
      requireTransport(method !== 'GET' || body === undefined, 'LIVE_VALIDATION_REQUEST_BODY_INVALID');
      return await new Promise((resolve, reject) => {
        let settled = false;
        const fail = error => {
          if (settled) return;
          settled = true;
          reject(error instanceof LiveValidationTransportError ? error : new LiveValidationTransportError(
            timedOut ? 'LIVE_VALIDATION_REQUEST_TIMEOUT' : controller.signal.aborted
              ? 'LIVE_VALIDATION_REQUEST_ABORTED' : 'LIVE_VALIDATION_TLS_REQUEST_FAILED'));
        };
        const request = requestImplementation(url, { ...tls, method, headers, agent: false,
          minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: peer.dnsName,
          signal: controller.signal,
          checkServerIdentity: (host, certificate) => checkServerIdentity(host, certificate)
            ?? (matchesPeer(certificate, peer) ? undefined : new LiveValidationTransportError('LIVE_VALIDATION_TLS_PEER_UNAPPROVED')),
        }, response => {
          const status = response.statusCode;
          if (!Number.isInteger(status) || status < 200 || status >= 600) {
            response.destroy(); fail(new LiveValidationTransportError('LIVE_VALIDATION_RESPONSE_INVALID')); return;
          }
          if (status >= 300 && status < 400) {
            response.destroy(); fail(new LiveValidationTransportError('LIVE_VALIDATION_REDIRECT_FORBIDDEN')); return;
          }
          const chunks = []; let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxResponseBytes) {
              fail(new LiveValidationTransportError('LIVE_VALIDATION_RESPONSE_LIMIT'));
              response.destroy(); request.destroy();
            } else chunks.push(chunk);
          });
          response.once('error', fail);
          response.once('aborted', () => fail(new LiveValidationTransportError('LIVE_VALIDATION_RESPONSE_INCOMPLETE')));
          response.once('end', () => {
            if (settled) return;
            settled = true;
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
          });
        });
        request.once('error', fail);
        request.end(body);
      });
    } catch (error) {
      if (controller.signal.aborted) throw new LiveValidationTransportError(
        timedOut ? 'LIVE_VALIDATION_REQUEST_TIMEOUT' : 'LIVE_VALIDATION_REQUEST_ABORTED');
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
    }
  };
  const requestJSON = async (route, { body, headers, ...options } = {}) => {
    requireTransport(typeof route === 'string' && route.startsWith('/') && !route.startsWith('//'),
      'LIVE_VALIDATION_PRIVATE_URL_FORBIDDEN');
    const requestHeaders = new Headers(headers);
    if (body !== undefined) requestHeaders.set('content-type', 'application/json');
    const result = await fetch(new URL(route, origin), { ...options, headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let parsed = null;
    try { if (result.status !== 204 && result.status !== 205) parsed = await result.json(); }
    catch { throw new LiveValidationTransportError('LIVE_VALIDATION_RESPONSE_JSON_INVALID'); }
    return { status: result.status, body: parsed };
  };
  return Object.freeze({ fetch, requestJSON });
}

function rejectRequest(response, code) {
  response.writeHead(403, { 'content-type': 'application/json', 'connection': 'close', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: { code } }));
}

/** TLS authenticates first; the operator route policy binds each approved certificate to its role. */
export function createLiveValidationMtlsServer({ tlsFiles, peers, authorizeRequest, handler,
  repositoryRoot = REPOSITORY_ROOT, timeoutMs = MAX_TIMEOUT_MS } = {}) {
  const tls = readLiveValidationTlsFiles(tlsFiles, repositoryRoot);
  requireTransport(Array.isArray(peers) && peers.length > 0 && peers.length <= 16, 'LIVE_VALIDATION_TLS_IDENTITY_INVALID');
  const identities = peers.map(peer => identity(peer, ['runtime', 'verifier', 'supervisor']));
  requireTransport(new Set(identities.map(peer => peer.fingerprintSha256)).size === identities.length,
    'LIVE_VALIDATION_TLS_IDENTITY_INVALID');
  requireTransport(typeof authorizeRequest === 'function' && typeof handler === 'function', 'LIVE_VALIDATION_ROUTE_POLICY_REQUIRED');
  bound(timeoutMs, MAX_TIMEOUT_MS, 'LIVE_VALIDATION_REQUEST_DEADLINE_INVALID');
  const server = createServer({ ...tls, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    maxHeaderSize: 16 * 1024, requestTimeout: timeoutMs, headersTimeout: Math.min(5_000, timeoutMs),
    keepAliveTimeout: 1_000,
  }, async (request, response) => {
    const peer = request.socket.authorized
      ? identities.find(candidate => matchesPeer(request.socket.getPeerCertificate(), candidate)) : undefined;
    if (!peer) { rejectRequest(response, 'LIVE_VALIDATION_TLS_PEER_UNAPPROVED'); return; }
    let allowed = false;
    try { allowed = await authorizeRequest({ role: peer.role, peer, method: request.method, path: request.url, headers: request.headers }); }
    catch { /* A policy failure denies admission without exposing its details. */ }
    if (allowed !== true) { rejectRequest(response, 'LIVE_VALIDATION_TLS_ROLE_FORBIDDEN'); return; }
    try { await handler(request, response, peer); }
    catch { if (!response.headersSent) rejectRequest(response, 'LIVE_VALIDATION_REQUEST_FAILED'); else response.destroy(); }
  });
  server.setTimeout(timeoutMs, socket => socket.destroy());
  return server;
}

/** Railway private DNS uses the encrypted environment network; the launcher owns separate HTTP health. */
export async function listenLiveValidationMtlsServer(server) {
  requireTransport(server && typeof server.listen === 'function' && !server.listening, 'LIVE_VALIDATION_TRANSPORT_INVALID');
  await new Promise((resolve, reject) => {
    const error = cause => { server.removeListener('listening', listening); reject(cause); };
    const listening = () => { server.removeListener('error', error); resolve(); };
    server.once('error', error); server.once('listening', listening);
    server.listen(8443, '::');
  });
  return server;
}
