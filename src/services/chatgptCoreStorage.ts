import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { getEnv } from '@platform/runtime/env.js';
import { resolveConfiguredPurposeBoundCredential } from '@shared/security/purposeBoundCredential.js';

const STORAGE_KEY = 'ARCANOS_CHATGPT_CORE_STORAGE_KEY';
const MAX_PROTECTED_BYTES = 512 * 1024;
export type CoreRecordKind = 'job-input' | 'job-output' | 'session';

/** Core ciphertext remains opaque to the legacy memory, job and operator readers. */
export function resolveCoreStorageKey(): Buffer {
  const value = resolveConfiguredPurposeBoundCredential({
    ownEnvironmentName: STORAGE_KEY,
    readEnvironmentValue: getEnv,
  });
  if (value && /^[A-Za-z0-9_-]{43}$/u.test(value)) {
    const key = Buffer.from(value, 'base64url');
    if (key.length === 32 && key.toString('base64url') === value) return key;
  }
  throw new Error('CORE_STORAGE_UNAVAILABLE');
}

export function coreRecordHash(input: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function associatedData(kind: CoreRecordKind, owner: string, locator: string): Buffer {
  return Buffer.from(JSON.stringify(['arcanos-chatgpt-core', 1, kind, owner, locator]), 'utf8');
}

export function sealCoreRecord(key: Buffer, kind: CoreRecordKind, owner: string, locator: string, value: unknown): string {
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  if (plaintext.length > MAX_PROTECTED_BYTES) throw new Error('CORE_STORAGE_UNAVAILABLE');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associatedData(kind, owner, locator));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openCoreRecord(
  key: Buffer, kind: CoreRecordKind, owner: string, locator: string, envelope: unknown,
): unknown {
  if (typeof envelope !== 'string'
    || envelope.length > Math.ceil((MAX_PROTECTED_BYTES + 28) * 4 / 3)
    || !/^[A-Za-z0-9_-]+$/u.test(envelope)) throw new Error('CORE_STORAGE_UNAVAILABLE');
  const bytes = Buffer.from(envelope, 'base64url');
  if (bytes.length <= 28) throw new Error('CORE_STORAGE_UNAVAILABLE');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAAD(associatedData(kind, owner, locator));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}
