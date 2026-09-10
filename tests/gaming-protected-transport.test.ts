import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Agent as HttpsAgent, createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import axios from 'axios';

const resolve4 = jest.fn<(hostname: string) => Promise<string[]>>();
const resolve6 = jest.fn<(hostname: string) => Promise<string[]>>();
const cancelDns = jest.fn();
jest.unstable_mockModule('node:dns/promises', () => ({
  Resolver: class {
    resolve4(hostname: string) { return resolve4(hostname); }
    resolve6(hostname: string) { return resolve6(hostname); }
    cancel() { cancelDns(); }
  }
}));
const { createProtectedDocumentFetchSession, extractFetchAndCleanDocument } = await import('../src/shared/webFetcher.js');

// Generate a disposable self-signed fixture CA/certificate in memory. No keys are stored or committed.
function createFixtureCertificate() {
  const der = (tag: number, ...values: Buffer[]): Buffer => {
    const body = Buffer.concat(values);
    const octets: number[] = [];
    for (let remaining = body.length; remaining > 0; remaining >>>= 8) octets.unshift(remaining & 255);
    const length = body.length < 128 ? Buffer.from([body.length]) : Buffer.from([128 + octets.length, ...octets]);
    return Buffer.concat([Buffer.from([tag]), length, body]);
  };
  const sequence = (...values: Buffer[]) => der(0x30, ...values);
  const oid = (hex: string) => der(6, Buffer.from(hex, 'hex'));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algorithm = sequence(oid('2a864886f70d01010b'), der(5));
  const subject = sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from('Disposable Gaming Fixture')))));
  const tbs = sequence(
    der(0xa0, der(2, Buffer.from([2]))), der(2, Buffer.from([1])), algorithm, subject,
    sequence(der(0x17, Buffer.from('240101000000Z')), der(0x17, Buffer.from('490101000000Z'))),
    subject, pair.publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(
      sequence(oid('551d13'), der(1, Buffer.from([255])), der(4, sequence(der(1, Buffer.from([255]))))),
      sequence(oid('551d11'), der(4, sequence(
        der(0x82, Buffer.from('fixture.example.com')), der(0x82, Buffer.from('www.fixture.example.com'))
      )))
    ))
  );
  const certificate = sequence(tbs, algorithm, der(3, Buffer.from([0]), sign('sha256', tbs, pair.privateKey)));
  return {
    key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
  };
}

describe('protected Gaming document single-hop transport', () => {
  let server: Server;
  let port: number;
  let certificate: ReturnType<typeof createFixtureCertificate>;
  let handler: (request: IncomingMessage, response: ServerResponse) => void;
  const requests: Array<{ host?: string; path?: string; method?: string; servername: string; headers: IncomingMessage['headers'] }> = [];
  const dials: ConnectionOptions[] = [];
  const sessions: ReturnType<typeof createProtectedDocumentFetchSession>[] = [];
  const originalCreateConnection = HttpsAgent.prototype.createConnection;
  const session = (options: Parameters<typeof createProtectedDocumentFetchSession>[0] = {}) => {
    const value = createProtectedDocumentFetchSession(options);
    sessions.push(value);
    return value;
  };
  let previousByteLimit: string | undefined;

  beforeAll(async () => {
    certificate = createFixtureCertificate();
    server = createServer(certificate, (request, response) => {
      requests.push({
        host: request.headers.host, path: request.url, method: request.method,
        servername: (request.socket as TLSSocket).servername,
        headers: request.headers
      });
      handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  beforeEach(() => {
    requests.length = 0;
    dials.length = 0;
    resolve4.mockReset().mockResolvedValue(['93.184.216.34']);
    resolve6.mockReset().mockResolvedValue(['2606:4700:4700::1111']);
    cancelDns.mockReset();
    previousByteLimit = process.env.WEB_FETCH_MAX_BYTES;
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<article><h1>Fixture RPG guide</h1><p>Cross the bridge to reach the observatory.</p></article>');
    };
    // Only the physical test socket is redirected to the local TLS fixture. Capture the actual
    // post-DNS dial first; keep production SNI/hostname verification and trust only the fixture CA.
    jest.spyOn(HttpsAgent.prototype, 'createConnection').mockImplementation(function (options, callback) {
      dials.push({ ...options });
      return originalCreateConnection.call(this, {
        ...options, host: '127.0.0.1', hostname: '127.0.0.1', port,
        ca: certificate.cert,
        lookup: () => { throw new Error('Unexpected unpinned hostname lookup'); }
      }, callback);
    });
  });

  afterEach(() => {
    for (const value of sessions.splice(0)) value.dispose();
    if (previousByteLimit === undefined) delete process.env.WEB_FETCH_MAX_BYTES;
    else process.env.WEB_FETCH_MAX_BYTES = previousByteLimit;
    jest.useRealTimers();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('pins the real HTTPS dial while preserving www, query order, logical Host and verified SNI at each hop', async () => {
    const acquisition = session();
    const first = await acquisition.fetch('https://www.fixture.example.com/Guide/Case?article=A%2FB&page=2&page=1');
    const second = await acquisition.fetch('https://fixture.example.com/Guide/Final');
    expect(first.publicUrl).toBe('https://www.fixture.example.com/Guide/Case?article=A%2FB&page=2&page=1');
    expect(second.status).toBe(200);
    expect(dials).toHaveLength(2);
    for (const dial of dials) {
      expect(dial.host).toBe('93.184.216.34');
      expect(dial.port).toBe(443);
      expect(dial.rejectUnauthorized).toBe(true);
      expect(dial.checkServerIdentity).toBeUndefined();
    }
    expect(dials.map((dial) => dial.servername)).toEqual(['www.fixture.example.com', 'fixture.example.com']);
    expect(requests.map(({ host, servername, method }) => ({ host, servername, method }))).toEqual([
      { host: 'www.fixture.example.com', servername: 'www.fixture.example.com', method: 'GET' },
      { host: 'fixture.example.com', servername: 'fixture.example.com', method: 'GET' }
    ]);
    expect(requests[0].path).toBe('/Guide/Case?article=A%2FB&page=2&page=1');
    expect(resolve4).toHaveBeenCalledTimes(2);
    expect(resolve6).toHaveBeenCalledTimes(2);
  });

  it('retains normal TLS certificate hostname verification', async () => {
    await expect(session().fetch('https://wrong-publisher.example.com/guide')).rejects.toMatchObject({ code: 'FETCH_FAILED' });
    expect(dials).toHaveLength(1);
    expect(dials[0].servername).toBe('wrong-publisher.example.com');
    expect(requests).toHaveLength(0);
  });

  it('pins a validated public IPv6 answer without an ordinary hostname lookup', async () => {
    resolve4.mockRejectedValue(new Error('No A record'));
    await session().fetch('https://fixture.example.com:443/guide');
    expect(dials).toHaveLength(1);
    expect(dials[0].host).toBe('2606:4700:4700::1111');
    expect(dials[0].servername).toBe('fixture.example.com');
    expect(requests[0].host).toBe('fixture.example.com');
  });

  it.each(['http://fixture.example.com/', 'https://user:pass@fixture.example.com/', 'https://fixture.example.com:8443/', 'file:///etc/passwd'])('rejects forbidden initial transport URL before DNS %s', async (url) => {
    await expect(session().fetch(url)).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(resolve4).not.toHaveBeenCalled();
    expect(resolve6).not.toHaveBeenCalled();
    expect(dials).toHaveLength(0);
  });

  it('does not let environment proxies or unrecognized options add secret headers', async () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
    try {
      const acquisition = session({ headers: { Authorization: 'test-placeholder-secret', Cookie: 'synthetic-cookie', Referer: 'https://private.invalid/' } } as never);
      await acquisition.fetch('https://fixture.example.com/guide');
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.authorization).toBeUndefined();
      expect(requests[0].headers.cookie).toBeUndefined();
      expect(requests[0].headers.referer).toBeUndefined();
      expect(requests[0].headers['proxy-authorization']).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });

  it('ignores ambient Axios headers, auth, params, transforms and request interceptors', async () => {
    const savedHeaders = axios.defaults.headers.common;
    const savedAuth = axios.defaults.auth;
    const savedParams = axios.defaults.params;
    const savedTransform = axios.defaults.transformRequest;
    const savedAdapter = axios.defaults.adapter;
    const interceptor = jest.fn((config) => config);
    const interceptorId = axios.interceptors.request.use(interceptor);
    axios.defaults.headers.common = { Authorization: 'test-placeholder-bearer', Cookie: 'synthetic-cookie', 'X-Internal-Token': 'synthetic-token' };
    axios.defaults.auth = { username: 'synthetic-user', password: 'test-placeholder-password' };
    axios.defaults.params = { privateToken: 'synthetic-query' };
    axios.defaults.transformRequest = [() => { throw new Error('Ambient transform must not run'); }];
    axios.defaults.adapter = async () => { throw new Error('Ambient adapter must not run'); };
    try {
      await session().fetch('https://fixture.example.com/guide?page=2');
      expect(interceptor).not.toHaveBeenCalled();
      expect(requests).toHaveLength(1);
      expect(requests[0].path).toBe('/guide?page=2');
      expect(Object.keys(requests[0].headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent']);
    } finally {
      axios.defaults.headers.common = savedHeaders;
      axios.defaults.auth = savedAuth;
      axios.defaults.params = savedParams;
      axios.defaults.transformRequest = savedTransform;
      axios.defaults.adapter = savedAdapter;
      axios.interceptors.request.eject(interceptorId);
    }
  });

  it('returns one redirect response without following its Location', async () => {
    handler = (_request, response) => { response.writeHead(302, { Location: '/next' }); response.end('moved'); };
    await expect(session().fetch('https://fixture.example.com/guide')).resolves.toMatchObject({ status: 302, location: '/next', body: 'moved' });
    expect(requests).toHaveLength(1);
  });

  it.each([
    undefined, ['/a', '/b'], 'x'.repeat(2049), 'https://fixture.example.com/a b'
  ])('rejects missing, duplicate, oversized, or raw-whitespace Location before any next request (%#)', async (location) => {
    handler = (_request, response) => { response.writeHead(302, location === undefined ? {} : { Location: location }); response.end(); };
    await expect(session().fetch('https://fixture.example.com/guide')).rejects.toMatchObject({ code: 'REDIRECT_LOCATION_INVALID', status: 302 });
    expect(requests).toHaveLength(1);
  });

  it('keeps a comma within a single Location intact and never treats 304 as a redirect', async () => {
    handler = (_request, response) => { response.writeHead(302, { Location: '/guide?values=one,two' }); response.end(); };
    const acquisition = session();
    await expect(acquisition.fetch('https://fixture.example.com/start')).resolves.toMatchObject({ location: '/guide?values=one,two' });
    handler = (_request, response) => { response.writeHead(304, { Location: '/unexpected' }); response.end(); };
    const result = await acquisition.fetch('https://fixture.example.com/cache');
    expect(result.status).toBe(304);
    expect(result.location).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  it.each([
    ['127.0.0.1'], ['10.0.0.1'], ['169.254.169.254'], ['93.184.216.34', '192.168.0.1']
  ])('rejects non-public or mixed IPv4 DNS results without a connection (%j)', async (...addresses) => {
    resolve4.mockResolvedValue(addresses as string[]);
    await expect(session().fetch('https://fixture.example.com/guide')).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
    expect(dials).toHaveLength(0);
  });

  it('rejects mixed public IPv4/private IPv6 DNS without a connection', async () => {
    resolve6.mockResolvedValue(['2606:4700:4700::1111', '::ffff:7f00:1']);
    await expect(session().fetch('https://fixture.example.com/guide')).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
    expect(dials).toHaveLength(0);
  });

  it.each([
    '0:0:0:0:0:ffff:7f00:1', '::2', '64:ff9b::a00:1', '100::1', '2001::1',
    '2001:db8::1', '2002:a00:1::1', '3fff:fff::1', '::ffff:5db8:d822'
  ])('rejects reserved/transition/mapped IPv6 DNS %s before dialing', async (address) => {
    resolve6.mockResolvedValue([address]);
    await expect(session().fetch('https://fixture.example.com/guide')).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
    expect(dials).toHaveLength(0);
  });

  it.each(['https://0x7f000001/', 'https://2130706433/', 'https://0177.0.0.1/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/'])('blocks numeric/private encodings %s', async (url) => {
    await expect(session().fetch(url)).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
    expect(dials).toHaveLength(0);
  });

  it('revalidates changed DNS on a later request without a private connection or fallback', async () => {
    const acquisition = session();
    await acquisition.fetch('https://fixture.example.com/one');
    resolve4.mockResolvedValue(['169.254.169.254']);
    await expect(acquisition.fetch('https://fixture.example.com/two')).rejects.toMatchObject({ code: 'NETWORK_DESTINATION_BLOCKED' });
    expect(dials).toHaveLength(1);
  });

  it('shares the wire/decoded allowance across redirect and final bodies', async () => {
    process.env.WEB_FETCH_MAX_BYTES = '120';
    handler = (_request, response) => { response.writeHead(302, { Location: '/final' }); response.end('x'.repeat(80)); };
    const acquisition = session();
    await acquisition.fetch('https://fixture.example.com/start');
    handler = (_request, response) => { response.writeHead(200); response.end('x'.repeat(41)); };
    await expect(acquisition.fetch('https://fixture.example.com/final')).rejects.toMatchObject({ code: 'TRANSFER_LIMIT' });
    expect(requests).toHaveLength(2);
  });

  it('rejects compressed expansion within the aggregate decoded allowance', async () => {
    process.env.WEB_FETCH_MAX_BYTES = '128';
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' });
      response.end(gzipSync('x'.repeat(4096)));
    };
    await expect(session().fetch('https://fixture.example.com/compressed')).rejects.toMatchObject({ code: 'DECODED_LIMIT' });
  });

  it('rejects malformed gzip and closes the upstream socket without another request', async () => {
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    handler = (request, response) => {
      request.socket.once('close', closed);
      response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' });
      response.write('invalid compressed document');
    };
    await expect(session().fetch('https://fixture.example.com/compressed')).rejects.toMatchObject({ code: 'FETCH_FAILED' });
    await socketClosed;
    expect(dials).toHaveLength(1);
  });

  it('rejects a large redirect body before another request', async () => {
    process.env.WEB_FETCH_MAX_BYTES = '128';
    handler = (_request, response) => { response.writeHead(302, { Location: '/final', 'Content-Length': '5000' }); response.end('x'.repeat(5000)); };
    await expect(session().fetch('https://fixture.example.com/start')).rejects.toMatchObject({ code: 'TRANSFER_LIMIT' });
    expect(requests).toHaveLength(1);
  });

  it('cancels both DNS families and starts no transfer', async () => {
    let reject4!: (reason: Error) => void;
    let reject6!: (reason: Error) => void;
    resolve4.mockImplementation(() => new Promise((_resolve, reject) => { reject4 = reject; }));
    resolve6.mockImplementation(() => new Promise((_resolve, reject) => { reject6 = reject; }));
    cancelDns.mockImplementation(() => { reject4(new Error('cancelled')); reject6(new Error('cancelled')); });
    const controller = new AbortController();
    const pending = session({ signal: controller.signal }).fetch('https://fixture.example.com/start');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancelDns).toHaveBeenCalledTimes(1);
    expect(dials).toHaveLength(0);
  });

  it('includes DNS in the absolute deadline', async () => {
    let reject4!: (reason: Error) => void;
    let reject6!: (reason: Error) => void;
    resolve4.mockImplementation(() => new Promise((_resolve, reject) => { reject4 = reject; }));
    resolve6.mockImplementation(() => new Promise((_resolve, reject) => { reject6 = reject; }));
    cancelDns.mockImplementation(() => { reject4(new Error('cancelled')); reject6(new Error('cancelled')); });
    await expect(session({ timeoutMs: 25 }).fetch('https://fixture.example.com/start')).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(cancelDns).toHaveBeenCalledTimes(1);
    expect(dials).toHaveLength(0);
  });

  it('cancels active body transfer and releases its TLS socket', async () => {
    const controller = new AbortController();
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    handler = (request, response) => {
      request.socket.once('close', closed);
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('unfinished');
      controller.abort();
    };
    await expect(session({ signal: controller.signal }).fetch('https://fixture.example.com/slow')).rejects.toMatchObject({ code: 'CANCELLED' });
    await socketClosed;
  });

  it('cancels an in-progress decoded transfer after response headers were delivered', async () => {
    const controller = new AbortController();
    let closed!: () => void;
    const socketClosed = new Promise<void>((resolve) => { closed = resolve; });
    handler = (request, response) => {
      request.socket.once('close', closed);
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('partial document');
      setTimeout(() => controller.abort(), 15);
    };
    await expect(session({ signal: controller.signal }).fetch('https://fixture.example.com/slow')).rejects.toMatchObject({ code: 'CANCELLED' });
    await socketClosed;
  });

  it('cancels a redirect body and prevents the next request', async () => {
    const controller = new AbortController();
    handler = (_request, response) => {
      response.writeHead(302, { Location: '/next' });
      response.write('partial redirect body');
      setTimeout(() => controller.abort(), 15);
    };
    const acquisition = session({ signal: controller.signal });
    await expect(acquisition.fetch('https://fixture.example.com/start')).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(acquisition.fetch('https://fixture.example.com/next')).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(dials).toHaveLength(1);
  });

  it('uses one deadline across requests and checks extraction against it', async () => {
    const acquisition = session({ timeoutMs: 100 });
    const first = await acquisition.fetch('https://fixture.example.com/start');
    const remaining = Math.max(0, acquisition.deadlineAt - Date.now());
    await new Promise((resolve) => setTimeout(resolve, remaining + 5));
    await expect(acquisition.fetch('https://fixture.example.com/final')).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' });
    expect(() => extractFetchAndCleanDocument(first.publicUrl, first.body, first.contentType, 10000, { deadlineAt: acquisition.deadlineAt })).toThrow('deadline exceeded');
    expect(dials).toHaveLength(1);
  });

  it('never follows HTML, JavaScript, rel=canonical, or metadata navigation', async () => {
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<meta http-equiv="refresh" content="0;url=https://private.invalid/"><link rel="canonical" href="https://private.invalid/"><script>location.href="https://private.invalid/"</script><article>Readable synthetic strategy guide.</article>');
    };
    const result = await session().fetch('https://fixture.example.com/start');
    const extracted = extractFetchAndCleanDocument(result.publicUrl, result.body, result.contentType, 10000);
    expect(extracted.text).toContain('Readable synthetic strategy guide');
    expect(extracted.text).not.toContain('location.href');
    expect(dials).toHaveLength(1);
  });
});
