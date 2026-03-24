import crypto from 'node:crypto';

type Entry = {
  sessionKey: string;
  tool: string;
  digest: string;
  expiresAtMs: number;
};

const NONCE_TTL_MS = Number(process.env.MCP_CONFIRM_TTL_MS ?? 60_000);

const store = new Map<string, Entry>();

function now() {
  return Date.now();
}

function cleanup() {
  const t = now();
  for (const [nonce, entry] of store.entries()) {
    if (entry.expiresAtMs <= t) store.delete(nonce);
  }
}

function stableStringify(value: unknown): string {
  // Deterministic-ish stringify: JSON + sorted keys for plain objects.
  if (value == null) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);

  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(',')}}`;
}

function digestPayload(payload: unknown): string {
  const input = stableStringify(payload);
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function issueConfirmationNonce(args: {
  tool: string;
  sessionKey: string;
  payloadToBind: unknown;
}): { nonce: string; expiresInMs: number } {
  cleanup();
  const nonce = crypto.randomUUID();
  const digest = digestPayload(args.payloadToBind);
  store.set(nonce, {
    sessionKey: args.sessionKey,
    tool: args.tool,
    digest,
    expiresAtMs: now() + NONCE_TTL_MS,
  });
  return { nonce, expiresInMs: NONCE_TTL_MS };
}

export function verifyAndConsumeNonce(args: {
  tool: string;
  sessionKey: string;
  payloadToBind: unknown;
  nonce?: string | null;
}): { ok: true } | { ok: false; reason: 'missing' | 'invalid' } {
  cleanup();
  if (!args.nonce) return { ok: false, reason: 'missing' };

  const entry = store.get(args.nonce);
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.sessionKey !== args.sessionKey) return { ok: false, reason: 'invalid' };
  if (entry.tool !== args.tool) return { ok: false, reason: 'invalid' };

  const digest = digestPayload(args.payloadToBind);
  if (digest !== entry.digest) return { ok: false, reason: 'invalid' };

  // consume
  store.delete(args.nonce);
  return { ok: true };
}
