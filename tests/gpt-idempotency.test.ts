import { describe, expect, it } from '@jest/globals';

import {
  buildGptIdempotencyDescriptor,
  buildGptRequestFingerprintHash,
  normalizeExplicitIdempotencyKey,
  resolveGptJobCreationSurface,
  resolvePublicGptJobCreationSurface,
} from '../src/shared/gpt/gptIdempotency.js';

describe('gpt idempotency fingerprinting', () => {
  it('normalizes prompt whitespace and object key ordering before hashing', () => {
    const leftHash = buildGptRequestFingerprintHash({
      gptId: 'ARCANOS-CORE',
      action: 'query',
      body: {
        prompt: 'Analyze   the deployment   timeout',
        answerMode: 'debug',
        messages: [
          {
            role: 'user',
            content: 'Please   inspect the   logs'
          }
        ]
      }
    });
    const rightHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'QUERY',
      body: {
        messages: [
          {
            content: 'Please inspect the logs',
            role: 'user'
          }
        ],
        answerMode: 'debug',
        prompt: 'Analyze the deployment timeout'
      }
    });

    expect(leftHash).toBe(rightHash);
  });

  it('excludes transport-only async hints from the semantic fingerprint', () => {
    const baseHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Investigate the queue backlog',
        waitForResultMs: 0
      }
    });
    const retriedHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Investigate the queue backlog',
        async: true,
        executionMode: 'async',
        waitForResultMs: 2500,
        pollIntervalMs: 100
      }
    });

    expect(baseHash).toBe(retriedHash);
  });

  it('does not collapse non-normalized request bodies onto the empty-object fingerprint', () => {
    const stringBodyHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: '  raw prompt body  '
    });
    const emptyObjectHash = buildGptRequestFingerprintHash({
      gptId: 'arcanos-core',
      action: 'query',
      body: {}
    });

    expect(stringBodyHash).not.toBe(emptyObjectHash);
  });

  it('produces explicit and derived idempotency descriptors without leaking prompt text', () => {
    const explicitDescriptor = buildGptIdempotencyDescriptor({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Trace the Railway timeout fallback'
      },
      surface: 'public-gpt',
      actorKey: 'user:42',
      explicitIdempotencyKey: 'retry-123'
    });
    const derivedDescriptor = buildGptIdempotencyDescriptor({
      gptId: 'arcanos-core',
      action: 'query',
      body: {
        prompt: 'Trace the Railway timeout fallback'
      },
      surface: 'public-gpt',
      actorKey: 'user:42'
    });

    expect(explicitDescriptor.source).toBe('explicit');
    expect(explicitDescriptor.publicIdempotencyKey).toBe('retry-123');
    expect(explicitDescriptor.idempotencyKeyHash).not.toContain('retry-123');
    expect(derivedDescriptor.source).toBe('derived');
    expect(derivedDescriptor.publicIdempotencyKey).toMatch(/^derived:/);
    expect(derivedDescriptor.fingerprintHash).toHaveLength(64);
  });

  it('isolates otherwise identical idempotency scopes by creation surface', () => {
    const surfaces = [
      'public-gpt',
      'custom-gpt-bridge',
      'gpt-access',
    ] as const;
    const scopeHashes = surfaces.map((surface) =>
      buildGptIdempotencyDescriptor({
        gptId: 'arcanos-core',
        action: 'query',
        body: { prompt: 'same request' },
        surface,
        actorKey: 'auth:shared-actor',
      }).scopeHash
    );

    expect(new Set(scopeHashes).size).toBe(surfaces.length);
  });

  it('classifies only server-owned public GPT provenance as public', () => {
    expect(resolveGptJobCreationSurface({
      requestPath: '/gpt/arcanos-core?mode=async',
      executionModeReason: 'explicit_async',
    })).toBe('public-gpt');
    expect(resolveGptJobCreationSurface({
      requestPath: '/GPT/arcanos-core/',
      executionModeReason: 'explicit_async',
    })).toBe('public-gpt');
    expect(resolveGptJobCreationSurface({
      requestPath: '/api/bridge/gpt',
      executionModeReason: 'bridge_query',
    })).toBe('custom-gpt-bridge');
    expect(resolveGptJobCreationSurface({
      requestPath: '/gpt-access/jobs/create',
      executionModeReason: 'gpt_access_create_ai_job',
    })).toBe('gpt-access');
    expect(resolvePublicGptJobCreationSurface({
      requestPath: '/gpt-access/jobs/create',
      executionModeReason: 'gpt_access_create_ai_job',
    })).toBeNull();
    expect(resolveGptJobCreationSurface({
      requestPath: '/api/bridge/gpt',
      executionModeReason: 'gpt_access_create_ai_job',
    })).toBeNull();
    expect(resolveGptJobCreationSurface({ requestPath: '/internal/gpt' })).toBeNull();
  });

  it('normalizes explicit idempotency key headers', () => {
    expect(normalizeExplicitIdempotencyKey('  retry-key  ')).toBe('retry-key');
    expect(normalizeExplicitIdempotencyKey('   ')).toBeNull();
    expect(normalizeExplicitIdempotencyKey(undefined)).toBeNull();
  });
});
