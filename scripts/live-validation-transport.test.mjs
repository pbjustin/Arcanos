import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createLiveValidationMtlsServer, createLiveValidationPrivateClient, listenLiveValidationMtlsServer,
  readLiveValidationTlsFiles, validateLiveValidationPrivateOrigin, LIVE_VALIDATION_PRIVATE_DEFAULT_TIMEOUT_MS,
  LIVE_VALIDATION_PRIVATE_MAX_TIMEOUT_MS } from './live-validation-transport.mjs';

const ORIGIN = 'https://supervisor.railway.internal:8443';
let directory;
const identities = {};
const files = {};

function write(file, text) { writeFileSync(path.join(directory, file), text, { mode: 0o600 }); }
function openssl(args) {
  const result = spawnSync('openssl', args, { cwd: directory, encoding: 'utf8', timeout: 10_000 });
  // Private material is confined to temp files and is never included in assertion output.
  assert.equal(result.status, 0, 'offline certificate preparation succeeded');
}
function leaf(name, { ca = 'ca', expired = false } = {}) {
  const dnsName = name === 'server' || name === 'expired-server' ? 'supervisor.railway.internal' : name + '.railway.internal';
  openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-subj', '/CN=' + dnsName, '-keyout', name + '.key', '-out', name + '.csr']);
  write(name + '.ext', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n'
    + 'extendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:' + dnsName + '\n');
  if (expired) {
    write('index', ''); write('serial', '1000\n');
    write('signer.conf', '[ca]\ndefault_ca=authority\n[authority]\ndatabase=' + path.join(directory, 'index')
      + '\nserial=' + path.join(directory, 'serial') + '\nnew_certs_dir=' + directory
      + '\ncertificate=' + path.join(directory, ca + '.crt') + '\nprivate_key=' + path.join(directory, ca + '.key')
      + '\ndefault_md=sha256\npolicy=names\n[names]\ncommonName=supplied\n');
    openssl(['ca', '-batch', '-notext', '-config', 'signer.conf', '-in', name + '.csr', '-out', name + '.crt',
      '-startdate', '20200101000000Z', '-enddate', '20200102000000Z', '-extfile', name + '.ext']);
  } else {
    openssl(['x509', '-req', '-in', name + '.csr', '-CA', ca + '.crt', '-CAkey', ca + '.key',
      '-CAcreateserial', '-days', '1', '-extfile', name + '.ext', '-out', name + '.crt']);
  }
  for (const suffix of ['key', 'crt']) chmodSync(path.join(directory, name + '.' + suffix), 0o600);
  const certificate = new X509Certificate(readFileSync(path.join(directory, name + '.crt')));
  identities[name] = { dnsName, fingerprintSha256: createHash('sha256').update(certificate.raw).digest('hex') };
  files[name] = { caFile: path.join(directory, 'ca.crt'), certFile: path.join(directory, name + '.crt'),
    keyFile: path.join(directory, name + '.key') };
}

before(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'arcanos-mtls-offline-')); chmodSync(directory, 0o700);
  for (const ca of ['ca', 'rogue-ca']) {
    openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
      '-subj', '/CN=offline-' + ca, '-addext', 'basicConstraints=critical,CA:TRUE',
      '-keyout', ca + '.key', '-out', ca + '.crt']);
    chmodSync(path.join(directory, ca + '.crt'), 0o600); chmodSync(path.join(directory, ca + '.key'), 0o600);
  }
  for (const name of ['server', 'runtime', 'verifier', 'outsider']) leaf(name);
  leaf('untrusted', { ca: 'rogue-ca' });
  leaf('expired', { expired: true });
  leaf('expired-server', { expired: true });
});
after(() => { rmSync(directory, { recursive: true, force: true }); });

function peers() {
  return ['runtime', 'verifier'].map(role => ({ role, ...identities[role] }));
}
function authorizer({ role, method, path: route }) {
  return (role === 'runtime' && method === 'POST' && route === '/v1/responses')
    || (role === 'verifier' && method === 'POST' && route === '/controller/register')
    || (['runtime', 'verifier'].includes(role) && method === 'GET' && route === '/session');
}
async function fixture(t, options = {}) {
  const server = createLiveValidationMtlsServer({ tlsFiles: files.server, peers: peers(), authorizeRequest: authorizer,
    handler: (_request, response, peer) => { response.end(JSON.stringify({ role: peer.role })); }, ...options });
  // Actual TLS handshake on loopback; the production URL/SNI/pin remain the private approved identity.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let requests = 0;
  const implementation = (url, transportOptions, callback) => {
    requests++;
    return httpsRequest({ ...transportOptions, hostname: '127.0.0.1', port: server.address().port,
      path: url.pathname + url.search, headers: { ...transportOptions.headers, host: url.host } }, callback);
  };
  const client = (name = 'runtime', options = {}) => createLiveValidationPrivateClient({ origin: ORIGIN,
    serverIdentity: identities.server, tlsFiles: files[name], requestImplementation: implementation, ...options });
  return { server, client, implementation, requestCount: () => requests };
}

test('private origins are canonical exact service DNS names on TLS port 8443', () => {
  assert.equal(validateLiveValidationPrivateOrigin(ORIGIN), ORIGIN);
  for (const value of [ORIGIN + '/', ORIGIN + '/v1', ORIGIN + '?x=1', ORIGIN + '#x', ORIGIN.replace('supervisor', 'Supervisor'),
    'http://supervisor.railway.internal:8443', 'https://supervisor.railway.internal',
    'https://supervisor.railway.internal:443', 'https://supervisor.railway.internal.:8443',
    'https://nested.supervisor.railway.internal:8443', 'https://localhost:8443', 'https://127.0.0.1:8443',
    'https://[::1]:8443', 'https://api.openai.com:8443', 'https://user@supervisor.railway.internal:8443']) {
    assert.throws(() => validateLiveValidationPrivateOrigin(value), { code: 'LIVE_VALIDATION_PRIVATE_ORIGIN_INVALID' });
  }
});

test('TLS inputs require absolute owner-only regular files outside checkout', () => {
  assert.ok(readLiveValidationTlsFiles(files.runtime).key.length > 0);
  const unsafe = path.join(directory, 'unsafe.key'); writeFileSync(unsafe, 'synthetic', { mode: 0o600 }); chmodSync(unsafe, 0o644);
  assert.throws(() => readLiveValidationTlsFiles({ ...files.runtime, keyFile: unsafe }), { code: 'LIVE_VALIDATION_TLS_FILE_UNSAFE' });
  const link = path.join(directory, 'link.key'); symlinkSync(files.runtime.keyFile, link);
  assert.throws(() => readLiveValidationTlsFiles({ ...files.runtime, keyFile: link }), { code: 'LIVE_VALIDATION_TLS_FILE_UNSAFE' });
  assert.throws(() => readLiveValidationTlsFiles({ ...files.runtime, keyFile: 'relative.key' }), { code: 'LIVE_VALIDATION_TLS_FILE_UNSAFE' });
  assert.throws(() => readLiveValidationTlsFiles(files.runtime, directory), { code: 'LIVE_VALIDATION_TLS_FILE_UNSAFE' });
});

test('real mTLS accepts runtime and verifier only on their allowed routes and preserves app authorization', async t => {
  const seen = [];
  const f = await fixture(t, { handler: (request, response, peer) => {
    seen.push({ role: peer.role, bearer: request.headers.authorization, sha: request.headers['x-arcanos-source-commit'],
      deployment: request.headers['x-arcanos-deployment-id'] });
    response.end(JSON.stringify({ role: peer.role }));
  } });
  const appHeaders = { authorization: 'Bearer synthetic-test-token', 'x-arcanos-source-commit': 'a'.repeat(40),
    'x-arcanos-deployment-id': 'synthetic-deployment' };
  assert.deepEqual(await f.client().requestJSON('/v1/responses', { method: 'POST', headers: appHeaders, body: { input: 'test' } }),
    { status: 200, body: { role: 'runtime' } });
  assert.equal((await f.client('verifier').requestJSON('/controller/register', { method: 'POST', body: {} })).status, 200);
  assert.equal((await f.client('verifier').requestJSON('/v1/responses', { method: 'POST', body: {} })).status, 403);
  assert.equal((await f.client().requestJSON('/controller/register', { method: 'POST', body: {} })).status, 403);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { role: 'runtime', bearer: appHeaders.authorization, sha: appHeaders['x-arcanos-source-commit'],
    deployment: appHeaders['x-arcanos-deployment-id'] });
});

test('unapproved same-CA peer is denied before an incomplete request body is read', async t => {
  let handled = 0;
  const f = await fixture(t, { handler: () => { handled++; } });
  const material = readLiveValidationTlsFiles(files.outsider);
  const status = await new Promise((resolve, reject) => {
    const request = f.implementation(new URL(ORIGIN + '/v1/responses'), { ...material, method: 'POST', agent: false,
      servername: identities.server.dnsName, rejectUnauthorized: true,
      headers: { 'content-type': 'application/json', 'content-length': '100' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.flushHeaders();
  });
  assert.equal(status, 403); assert.equal(handled, 0);
});

test('same fingerprint cannot authenticate an unexpected role DNS SAN', async t => {
  const f = await fixture(t, { peers: [{ role: 'runtime', ...identities.runtime, dnsName: 'wrong.railway.internal' }] });
  assert.equal((await f.client().requestJSON('/session')).status, 403);
});

test('expired and untrusted client certificates fail actual TLS handshakes', async t => {
  let handled = 0;
  const f = await fixture(t, { handler: () => { handled++; } });
  for (const name of ['expired', 'untrusted']) {
    await assert.rejects(f.client(name).requestJSON('/session'), { code: 'LIVE_VALIDATION_TLS_REQUEST_FAILED' });
  }
  assert.equal(handled, 0);
});

test('client pins server fingerprint and rejects expired server certificates', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client('runtime', { serverIdentity: { ...identities.server,
    fingerprintSha256: identities.verifier.fingerprintSha256 } }).requestJSON('/session'),
  { code: 'LIVE_VALIDATION_TLS_PEER_UNAPPROVED' });
  const expired = await fixture(t, { tlsFiles: files['expired-server'] });
  await assert.rejects(expired.client('runtime', { serverIdentity: identities['expired-server'] }).requestJSON('/session'),
    { code: 'LIVE_VALIDATION_TLS_REQUEST_FAILED' });
});

test('one scoped client rejects public or alternative private URLs before any transport request', async t => {
  const f = await fixture(t); const client = f.client();
  for (const url of ['https://api.openai.com/v1/responses', 'https://other.railway.internal:8443/session',
    'https://127.0.0.1:8443/session', ORIGIN + '/session#fragment', 'https://name@supervisor.railway.internal:8443/session']) {
    await assert.rejects(client.fetch(url, { headers: { authorization: 'Bearer test-placeholder' }, body: 'test' }),
      { code: 'LIVE_VALIDATION_PRIVATE_URL_FORBIDDEN' });
  }
  await assert.rejects(client.requestJSON('//api.openai.com/v1/responses'), { code: 'LIVE_VALIDATION_PRIVATE_URL_FORBIDDEN' });
  await assert.rejects(client.fetch(ORIGIN + '/session', { headers: { host: 'public.example' } }),
    { code: 'LIVE_VALIDATION_PRIVATE_HEADER_FORBIDDEN' });
  assert.equal(f.requestCount(), 0);
});

test('redirects are rejected without a second connection', async t => {
  const f = await fixture(t, { handler: (_request, response) => { response.writeHead(302, { location: 'https://api.openai.com' }); response.end(); } });
  await assert.rejects(f.client().requestJSON('/session'), { code: 'LIVE_VALIDATION_REDIRECT_FORBIDDEN' });
  assert.equal(f.requestCount(), 1);
});

test('request and streamed response limits are enforced without retries', async t => {
  const f = await fixture(t, { handler: (_request, response) => { response.write('a'.repeat(33)); response.end('b'.repeat(33)); } });
  const client = f.client('runtime', { maxResponseBytes: 64, maxRequestBytes: 64 });
  await assert.rejects(client.fetch(ORIGIN + '/v1/responses', { method: 'POST', body: 'x'.repeat(65) }),
    { code: 'LIVE_VALIDATION_REQUEST_LIMIT' });
  assert.equal(f.requestCount(), 0);
  await assert.rejects(client.fetch(ORIGIN + '/session'), { code: 'LIVE_VALIDATION_RESPONSE_LIMIT' });
  assert.equal(f.requestCount(), 1);
});

test('absolute request deadline bounds a stalled response body and caller cancellation', async t => {
  const f = await fixture(t, { handler: (_request, response) => { response.writeHead(200); response.write('{'); } });
  const client = f.client('runtime', { timeoutMs: 50 });
  const started = Date.now();
  await assert.rejects(client.requestJSON('/session'), { code: 'LIVE_VALIDATION_REQUEST_TIMEOUT' });
  assert.ok(Date.now() - started < 1_000);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20);
  await assert.rejects(client.requestJSON('/session', { signal: controller.signal }), { code: 'LIVE_VALIDATION_REQUEST_ABORTED' });
  clearTimeout(timer);
  assert.equal(f.requestCount(), 2);
  await assert.rejects(client.requestJSON('/session', { timeoutMs: 51 }), { code: 'LIVE_VALIDATION_REQUEST_DEADLINE_INVALID' });
});

test('explicit acceptance transport can return after the former 60-second verifier deadline without widening default requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const delayedRequest = (_url, options, callback) => {
    calls++;
    const request = new EventEmitter(); request.destroy = () => {};
    options.signal.addEventListener('abort', () => request.emit('error', new Error('offline-aborted')));
    request.end = () => setTimeout(() => {
      const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; response.destroy = () => {};
      callback(response); response.emit('data', Buffer.from('{"audit":"completed"}')); response.emit('end');
    }, 61_000);
    return request;
  };
  const configuration = { origin: ORIGIN, serverIdentity: identities.server, tlsFiles: files.verifier,
    requestImplementation: delayedRequest };
  const extended = createLiveValidationPrivateClient({ ...configuration, timeoutMs: 315_000 });
  const result = extended.requestJSON('/session', { timeoutMs: 315_000 });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(61_000);
  assert.deepEqual(await result, { status: 200, body: { audit: 'completed' } });
  const normal = createLiveValidationPrivateClient(configuration);
  await assert.rejects(normal.requestJSON('/session', { timeoutMs: 315_000 }), { code: 'LIVE_VALIDATION_REQUEST_DEADLINE_INVALID' });
  assert.equal(calls, 1); assert.equal(LIVE_VALIDATION_PRIVATE_DEFAULT_TIMEOUT_MS, 120_000);
  assert.equal(LIVE_VALIDATION_PRIVATE_MAX_TIMEOUT_MS, 600_000);
});

test('long private deadlines remain capped at ten minutes and runtime server idle can cover bounded acceptance', async t => {
  const f = await fixture(t, { timeoutMs: 600_000 });
  assert.equal(f.server.timeout, 600_000); assert.equal(f.server.requestTimeout, 600_000);
  assert.equal(f.server.headersTimeout, 5_000);
  assert.throws(() => f.client('verifier', { timeoutMs: 600_001 }), { code: 'LIVE_VALIDATION_REQUEST_DEADLINE_INVALID' });
  assert.throws(() => createLiveValidationMtlsServer({ tlsFiles: files.server, peers: peers(), authorizeRequest: authorizer,
    handler() {}, timeoutMs: 600_001 }), { code: 'LIVE_VALIDATION_REQUEST_DEADLINE_INVALID' });
});

test('Fetch Request bodies are bounded incrementally and deadline cancels a stalled body before networking', async t => {
  const f = await fixture(t); const client = f.client('runtime', { maxRequestBytes: 64, timeoutMs: 30 });
  const request = new Request(ORIGIN + '/v1/responses', { method: 'POST', body: 'x'.repeat(65) });
  await assert.rejects(client.fetch(request), { code: 'LIVE_VALIDATION_REQUEST_LIMIT' });
  let canceled = false;
  const stream = new ReadableStream({ cancel() { canceled = true; } });
  await assert.rejects(client.fetch(new Request(ORIGIN + '/v1/responses', { method: 'POST', body: stream, duplex: 'half' })),
    { code: 'LIVE_VALIDATION_REQUEST_TIMEOUT' });
  assert.equal(canceled, true); assert.equal(f.requestCount(), 0);
});

test('server configuration is closed without explicit role policy and listener binds the fixed private port', async () => {
  assert.throws(() => createLiveValidationMtlsServer({ tlsFiles: files.server, peers: peers(), handler() {} }),
    { code: 'LIVE_VALIDATION_ROUTE_POLICY_REQUIRED' });
  assert.throws(() => createLiveValidationMtlsServer({ tlsFiles: files.server,
    peers: [{ role: 'runtime', ...identities.runtime }, { role: 'verifier', ...identities.runtime }], authorizeRequest: authorizer, handler() {} }),
  { code: 'LIVE_VALIDATION_TLS_IDENTITY_INVALID' });
  const server = new EventEmitter(); server.listening = false;
  server.listen = (port, host) => { assert.equal(port, 8443); assert.equal(host, '::'); queueMicrotask(() => server.emit('listening')); };
  assert.equal(await listenLiveValidationMtlsServer(server), server);
});
