import { createServer, type RequestListener, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { JWK } from 'jose';

export const TUTOR_E2E_ISSUER = 'https://tutor-e2e-issuer.invalid/';
export const TUTOR_E2E_JWKS_URL = TUTOR_E2E_ISSUER + 'jwks';
export const TUTOR_E2E_RESOURCE = 'https://tutor-e2e-resource.invalid/chatgpt/mcp';
export const TUTOR_E2E_PROVIDER_KEY = 'synthetic-tutor-e2e-provider-key';
export const TUTOR_E2E_PRIVATE_ERROR = 'private-provider-diagnostic-' + randomUUID();

export interface ObservedTutorProviderRequest {
  kind: 'generation' | 'hrc';
  body: { model: string; input: unknown; store?: boolean; [key: string]: unknown };
  disconnected: boolean;
}

export async function listenOnLoopback(listener: RequestListener) {
  const server = createServer(listener).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected an ephemeral loopback listener');
  return { server, origin: 'http://127.0.0.1:' + address.port };
}

export async function closeLoopbackServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await withinDeadline(closed, 'Loopback server cleanup', 2_000);
}

export async function withinDeadline<T>(operation: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(label + ' exceeded fixture deadline')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Answers depend only on the actual HTTP body, never a test's expected marker. */
function syntheticResponse(body: ObservedTutorProviderRequest['body'], kind: ObservedTutorProviderRequest['kind']) {
  const marker = JSON.stringify(body.input).match(/palette-[0-9a-f-]{36}/u)?.[0];
  const answer = kind === 'hrc'
    ? JSON.stringify({ fidelity: 1, resilience: 1, verdict: 'Synthetic wire HRC evaluation' })
    : marker
      ? 'Your selected palette code is ' + marker + '.'
      : 'No earlier palette code is available in this conversation.';
  return {
    object: 'response', id: 'resp_' + randomUUID(), created_at: Math.floor(Date.now() / 1_000),
    model: body.model, status: 'completed', error: null, incomplete_details: null,
    output: [{
      type: 'message', id: 'msg_' + randomUUID(), status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: answer, annotations: [] }],
    }],
    usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144 },
  };
}

/** Real HTTP JWKS/Responses fixture; all other paths or credentials fail the suite. */
export async function startTutorUpstreamFixture(publicKey: JWK) {
  const requests: ObservedTutorProviderRequest[] = [];
  const violations: string[] = [];
  let jwksRequests = 0;
  let behavior: 'answer' | 'generation-error' | 'hrc-error' | 'hold-generation' = 'answer';
  const observers = new Set<() => void>();
  const announce = () => { for (const observer of observers) observer(); };
  const upstream = await listenOnLoopback((req, res) => {
    if (req.method === 'GET' && req.url === '/jwks') {
      jwksRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/jwk-set+json' });
      res.end(JSON.stringify({ keys: [publicKey] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses'
      || req.headers.authorization !== 'Bearer ' + TUTOR_E2E_PROVIDER_KEY) {
      violations.push('Unexpected upstream method, path or credential');
      res.writeHead(400).end();
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 128_000) {
        violations.push('Unbounded provider request');
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      let body: ObservedTutorProviderRequest['body'];
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof body.model !== 'string' || !body.input) throw new Error('Missing Responses input');
      } catch {
        violations.push('Malformed Responses request');
        res.writeHead(400).end();
        return;
      }
      const kind = JSON.stringify(body.input).includes('Hallucination-Resistant Core') ? 'hrc' : 'generation';
      const observed: ObservedTutorProviderRequest = { kind, body, disconnected: false };
      requests.push(observed);
      res.once('close', () => {
        observed.disconnected = !res.writableEnded;
        announce();
      });
      announce();
      if (kind === 'generation' && behavior === 'hold-generation') return;
      const fail = (kind === 'generation' && behavior === 'generation-error')
        || (kind === 'hrc' && behavior === 'hrc-error');
      res.writeHead(fail ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fail
        ? { error: { type: 'server_error', message: TUTOR_E2E_PRIVATE_ERROR, code: 'fixture_failure' } }
        : syntheticResponse(body, kind)));
    });
  });
  return {
    ...upstream, requests, violations,
    get jwksRequests() { return jwksRequests; },
    setBehavior(value: typeof behavior) { behavior = value; },
    reset() { requests.length = 0; violations.length = 0; jwksRequests = 0; behavior = 'answer'; },
    async waitFor(predicate: () => boolean, label: string) {
      if (predicate()) return;
      let observe: () => void = () => undefined;
      try {
        await withinDeadline(new Promise<void>(resolve => {
          observe = () => { if (predicate()) resolve(); };
          observers.add(observe);
          observe();
        }), label);
      } finally { observers.delete(observe); }
    },
    close: () => closeLoopbackServer(upstream.server),
  };
}
