import { z } from 'zod';

export const GPT_ACCESS_DEVICE_AUDIENCE = 'gpt-access-device-v1' as const;
export const GPT_ACCESS_DEVICE_SCOPES = ['jobs.create', 'jobs.result', 'capabilities.read', 'capabilities.run'] as const;
export const GPT_ACCESS_DEVICE_ACTIONS = ['git.status', 'tests.run', 'patch.preview', 'patch.apply'] as const;
export const GPT_ACCESS_DEVICE_GPT_IDS = ['arcanos-core'] as const;
export const GPT_ACCESS_PAIRING_TTL_MS = 5 * 60 * 1000;
export const GPT_ACCESS_DEVICE_TTL_MS = 60 * 60 * 1000;
export const GPT_ACCESS_DEVICE_RENEWAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GPT_ACCESS_DEVICE_TOKEN_PATTERN = /^agd1\.[A-Za-z0-9_-]{43}$/u;
export const GPT_ACCESS_PAIRING_TOKEN_PATTERN = /^agp1\.[A-Za-z0-9_-]{43}$/u;

const contextId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const GptAccessDeviceOriginSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}, 'An exact HTTPS origin is required.');
const uniqueValues = <T>(values: T[]) => new Set(values).size === values.length;
export const GptAccessDeviceGrantSchema = z.object({
  principalId: contextId,
  workspaceId: contextId,
  origin: GptAccessDeviceOriginSchema,
  scopes: z.array(z.enum(GPT_ACCESS_DEVICE_SCOPES)).min(1).max(4).refine(uniqueValues),
  capabilityActions: z.array(z.enum(GPT_ACCESS_DEVICE_ACTIONS)).max(4).refine(uniqueValues)
}).strict();
export const GptAccessPairingCompleteSchema = z.object({
  pairingToken: z.string().regex(GPT_ACCESS_PAIRING_TOKEN_PATTERN),
  localIdentity: z.string().uuid()
}).strict();
export type GptAccessDeviceGrant = z.infer<typeof GptAccessDeviceGrantSchema>;
export type GptAccessDeviceScope = typeof GPT_ACCESS_DEVICE_SCOPES[number];
export type GptAccessDeviceAction = typeof GPT_ACCESS_DEVICE_ACTIONS[number];

export interface GptAccessPairingRecord extends GptAccessDeviceGrant {
  pairingHash: string;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}

export interface GptAccessDeviceRecord extends GptAccessDeviceGrant {
  deviceId: string;
  localIdentityHash: string;
  credentialHash: string;
  audience: typeof GPT_ACCESS_DEVICE_AUDIENCE;
  pairedAt: string;
  issuedAt: string;
  expiresAt: string;
  renewalExpiresAt: string;
  revokedAt: string | null;
  gptIds: string[];
}
export type GptAccessDevicePrincipal = Omit<GptAccessDeviceRecord, 'credentialHash' | 'localIdentityHash'>;

export type GptAccessDeviceErrorCode =
  | 'DEVICE_AUTH_REQUIRED' | 'DEVICE_AUTH_INVALID' | 'DEVICE_CREDENTIAL_EXPIRED'
  | 'DEVICE_REVOKED' | 'DEVICE_ORIGIN_DENIED' | 'DEVICE_RENEWAL_REQUIRED'
  | 'DEVICE_AUTH_UNAVAILABLE' | 'DEVICE_SCOPE_DENIED'
  | 'PAIRING_INVALID' | 'PAIRING_EXPIRED' | 'PAIRING_USED';

export class GptAccessDeviceAuthError extends Error {
  constructor(public readonly code: GptAccessDeviceErrorCode, public readonly statusCode = 401) {
    super(code);
    this.name = 'GptAccessDeviceAuthError';
  }
}

/** Repository values contain only one-way digests, never bearer/pairing material. */
export interface GptAccessDeviceRepository {
  createPairing(record: GptAccessPairingRecord): Promise<void>;
  consumePairing(pairingHash: string, device: Omit<GptAccessDeviceRecord, keyof GptAccessDeviceGrant>, now: string, origin: string): Promise<GptAccessDeviceRecord>;
  findByCredentialHash(credentialHash: string): Promise<GptAccessDeviceRecord | null>;
  rotate(credentialHash: string, replacementHash: string, issuedAt: string, expiresAt: string): Promise<GptAccessDeviceRecord>;
  revoke(deviceId: string, principalId: string, workspaceId: string, now: string): Promise<boolean>;
}

export interface GptAccessDeviceSessionMetadata {
  ok: true;
  deviceId: string;
  tokenType: 'Bearer';
  audience: typeof GPT_ACCESS_DEVICE_AUDIENCE;
  origin: string;
  issuedAt: string;
  expiresAt: string;
  renewalExpiresAt: string;
  scopes: GptAccessDeviceScope[];
  capabilityActions: GptAccessDeviceAction[];
  gptIds: string[];
}
export interface GptAccessDeviceSession extends GptAccessDeviceSessionMetadata {
  credential: string;
}
