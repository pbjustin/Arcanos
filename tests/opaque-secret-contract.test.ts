import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { timingSafeEqualOpaqueSecret } from '../src/shared/security/opaqueSecret.js';

const migratedTypeScriptBoundaries = [
  'src/core/persistenceManagerHierarchy.ts',
  'src/mcp/auth.ts',
  'src/platform/observability/appMetrics.ts',
  'src/routes/api-daemon.ts',
  'src/routes/daemonStore.ts',
  'src/routes/debug-confirmation.ts',
  'src/routes/register.ts',
  'src/routes/worker-helper.ts',
  'src/services/bridgeSocket.ts',
  'src/services/controlPlane/approval.ts',
  'src/services/customGptBridgeService.ts',
  'src/services/gptAccessGateway.ts',
  'src/services/gptDagBridge.ts',
  'src/services/persistenceManager.ts',
  'src/services/rootDeepDiagnosticsBridge.ts',
  'src/transport/http/middleware/capabilityGate.ts',
  'src/transport/http/middleware/confirmGate.ts',
] as const;

function containsCredentialMarker(value: unknown, markers: readonly string[]): boolean {
  let rendered: string;
  try {
    rendered = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }

  return markers.some((marker) => {
    const encodings = [
      marker,
      Buffer.from(marker, 'utf8').toString('hex'),
      Buffer.from(marker, 'utf8').toString('base64'),
      encodeURIComponent(marker),
      createHash('sha256').update(marker, 'utf8').digest('hex'),
      createHash('sha256').update(marker, 'utf8').digest('base64'),
      createHash('sha256').update(marker, 'utf16le').digest('hex'),
      createHash('sha256').update(marker, 'utf16le').digest('base64'),
      ...(marker.length >= 12 ? [marker.slice(0, 12), marker.slice(-12)] : []),
    ];
    return encodings.some((encoding) => encoding.length > 0 && rendered.includes(encoding));
  });
}

describe('opaque credential verification contract', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['equal ASCII', 'phase-2a-value', 'phase-2a-value', true],
    ['unequal same length', 'phase-2a-value', 'phase-2a-valuf', false],
    ['unequal different length', 'phase-2a-value', 'phase-2a-value-longer', false],
    ['case-sensitive', 'Phase-2A-Value', 'phase-2a-value', false],
    ['leading whitespace is significant', ' phase-2a-value', 'phase-2a-value', false],
    ['trailing whitespace is significant', 'phase-2a-value ', 'phase-2a-value', false],
    ['whitespace-only strings remain opaque values', '   ', '   ', true],
    ['equal Unicode', 'phase-2a-sécurité-🔐', 'phase-2a-sécurité-🔐', true],
    ['Unicode normalization is not implicit', 'café', 'café', false],
    ['equal lone surrogate code units', '\uD800', '\uD800', true],
    ['distinct lone surrogate code units', '\uD800', '\uD801', false],
    ['empty values are not credentials', '', '', false],
    ['empty provided value is rejected', '', 'phase-2a-value', false],
    ['empty expected value is rejected', 'phase-2a-value', '', false],
  ] as const)('%s', (_name, provided, expected, decision) => {
    expect(timingSafeEqualOpaqueSecret(provided, expected)).toBe(decision);
  });

  it('fails closed for missing and runtime non-string inputs', () => {
    const compare = timingSafeEqualOpaqueSecret as (
      provided: unknown,
      expected: unknown,
    ) => boolean;

    expect(compare(undefined, 'configured')).toBe(false);
    expect(compare(null, 'configured')).toBe(false);
    expect(compare('provided', undefined)).toBe(false);
    expect(compare('provided', null)).toBe(false);
    expect(compare(123, '123')).toBe(false);
    expect(compare('true', true)).toBe(false);
    expect(compare(Buffer.from('provided'), 'provided')).toBe(false);
  });

  it('does not impose a shared length cap', () => {
    const longCredential = 'λ'.repeat(5_000);
    const wrongCredential = `${longCredential.slice(0, -1)}μ`;

    expect(timingSafeEqualOpaqueSecret(longCredential, longCredential)).toBe(true);
    expect(timingSafeEqualOpaqueSecret(longCredential, wrongCredential)).toBe(false);
  });

  it.each(migratedTypeScriptBoundaries)(
    'keeps %s on the authoritative equality primitive',
    (relativePath) => {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source.includes('timingSafeEqualOpaqueSecret')).toBe(true);
    },
  );

  it('has no logging or stdio side effects and does not interpolate credentials into errors', () => {
    const expected = ['phase2a', 'opaque', 'sécurité', 'fixture'].join('-');
    const provided = `${expected.slice(0, -1)}x`;
    const observed: unknown[] = [];
    const consoleSpies = [
      jest.spyOn(console, 'debug').mockImplementation((...args) => { observed.push(args); }),
      jest.spyOn(console, 'error').mockImplementation((...args) => { observed.push(args); }),
      jest.spyOn(console, 'info').mockImplementation((...args) => { observed.push(args); }),
      jest.spyOn(console, 'log').mockImplementation((...args) => { observed.push(args); }),
      jest.spyOn(console, 'warn').mockImplementation((...args) => { observed.push(args); }),
    ];
    const stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let thrown: unknown;

    try {
      expect(timingSafeEqualOpaqueSecret(provided, expected)).toBe(false);
    } catch (error: unknown) {
      thrown = error;
    }

    observed.push(
      ...consoleSpies.flatMap((spy) => spy.mock.calls),
      ...stdoutSpy.mock.calls,
      ...stderrSpy.mock.calls,
      thrown instanceof Error
        ? { name: thrown.name, message: thrown.message, stack: thrown.stack }
        : thrown,
    );

    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(stdoutSpy.mock.calls.length === 0).toBe(true);
    expect(stderrSpy.mock.calls.length === 0).toBe(true);
    expect(thrown === undefined).toBe(true);
    expect(containsCredentialMarker(observed, [expected, provided])).toBe(false);
  });
});
