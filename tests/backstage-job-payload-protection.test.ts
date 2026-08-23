import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME,
  BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME,
  BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
  BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
  BackstageJobPayloadProtectionError,
  resolveBackstageJobPayloadProtectionConfig,
  sealBackstageJobPayload,
  unsealBackstageJobPayload,
  type BackstageJobPayloadEnvelope,
  type BackstageJobPayloadIdentity,
  type BackstageJobPayloadProtectionEnvironmentName,
  type BackstageJobPayloadProtectionEnvironmentReader,
} from '../src/shared/backstage/backstageJobPayloadProtection.js';

const CURRENT_KEY = Buffer.alloc(32, 0x19).toString('base64');
const NEXT_KEY = Buffer.alloc(32, 0x73).toString('base64');
const THIRD_KEY = Buffer.alloc(32, 0xb4).toString('base64');
const SENSITIVE_TEXT = 'private-booking-fact-never-persist-plaintext';

const inputIdentity: BackstageJobPayloadIdentity = {
  envelopeId: 'booking-envelope-001',
  gptId: 'backstage-booker',
  action: 'generateBooking',
  universeId: 'my-universe-2k26',
};

const outputIdentity: BackstageJobPayloadIdentity = {
  jobId: 'job-booking-001',
  gptId: 'backstage-booker',
  action: 'generateBooking',
  universeId: 'my-universe-2k26',
};

function environmentReader(
  values: Partial<Record<BackstageJobPayloadProtectionEnvironmentName, string>>
): BackstageJobPayloadProtectionEnvironmentReader {
  return (environmentName) => values[environmentName];
}

function config(
  currentKey = CURRENT_KEY,
  previousKey?: string
) {
  return resolveBackstageJobPayloadProtectionConfig(environmentReader({
    [BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME]: currentKey,
    ...(previousKey === undefined
      ? {}
      : { [BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME]: previousKey }),
  }));
}

function mutateCanonicalBase64(value: string): string {
  const replacement = value[0] === 'A' ? 'B' : 'A';
  return `${replacement}${value.slice(1)}`;
}

function captureProtectionError(operation: () => unknown): BackstageJobPayloadProtectionError {
  try {
    operation();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BackstageJobPayloadProtectionError);
    return error as BackstageJobPayloadProtectionError;
  }
  throw new Error('Expected the payload protection operation to fail.');
}

describe('Backstage queue payload protection', () => {
  it('round-trips input and output payloads without exposing plaintext in either envelope', () => {
    const protectionConfig = config();
    const inputPayload = {
      prompt: SENSITIVE_TEXT,
      payload: { universeId: 'my-universe-2k26', week: 17 },
    };
    const outputPayload = {
      ok: true,
      result: { booking: SENSITIVE_TEXT, sections: 8 },
    };

    const inputEnvelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      payload: inputPayload,
      config: protectionConfig,
    });
    const outputEnvelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
      identity: outputIdentity,
      payload: outputPayload,
      config: protectionConfig,
    });

    expect(JSON.stringify(inputEnvelope)).not.toContain(SENSITIVE_TEXT);
    expect(JSON.stringify(outputEnvelope)).not.toContain(SENSITIVE_TEXT);
    expect(inputEnvelope.iv).not.toBe(outputEnvelope.iv);
    expect(unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      envelope: inputEnvelope,
      config: protectionConfig,
    })).toEqual(inputPayload);
    expect(unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
      identity: outputIdentity,
      envelope: outputEnvelope,
      config: protectionConfig,
    })).toEqual(outputPayload);
  });

  it.each(['ciphertext', 'iv', 'authTag'] as const)(
    'fails closed when envelope %s is tampered',
    (field) => {
      const protectionConfig = config();
      const envelope = sealBackstageJobPayload({
        purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
        identity: inputIdentity,
        payload: { prompt: SENSITIVE_TEXT },
        config: protectionConfig,
      });
      const tamperedEnvelope = {
        ...envelope,
        [field]: mutateCanonicalBase64(envelope[field]),
      };

      const error = captureProtectionError(() => unsealBackstageJobPayload({
        purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
        identity: inputIdentity,
        envelope: tamperedEnvelope,
        config: protectionConfig,
      }));
      expect(error.code).toBe('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
    }
  );

  it('rejects a valid envelope at the wrong input/output purpose boundary', () => {
    const protectionConfig = config();
    const envelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      payload: { prompt: SENSITIVE_TEXT },
      config: protectionConfig,
    });

    const error = captureProtectionError(() => unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
      identity: outputIdentity,
      envelope,
      config: protectionConfig,
    }));
    expect(error.code).toBe('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  });

  it.each([
    ['envelopeId', { ...inputIdentity, envelopeId: 'booking-envelope-002' }],
    ['gptId', { ...inputIdentity, gptId: 'another-gpt' }],
    ['action', { ...inputIdentity, action: 'simulateMatch' }],
    ['universeId', { ...inputIdentity, universeId: 'another-universe' }],
  ] as const)('binds input ciphertext to the exact %s AAD value', (_field, identity) => {
    const protectionConfig = config();
    const envelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      payload: { prompt: SENSITIVE_TEXT },
      config: protectionConfig,
    });

    const error = captureProtectionError(() => unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity,
      envelope,
      config: protectionConfig,
    }));
    expect(error.code).toBe('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  });

  it('binds output ciphertext to the exact job identity', () => {
    const protectionConfig = config();
    const envelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
      identity: outputIdentity,
      payload: { result: SENSITIVE_TEXT },
      config: protectionConfig,
    });

    const error = captureProtectionError(() => unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_OUTPUT_PURPOSE,
      identity: { ...outputIdentity, jobId: 'job-booking-002' },
      envelope,
      config: protectionConfig,
    }));
    expect(error.code).toBe('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  });

  it('opens old ciphertext with the previous key while sealing only with the rotated current key', () => {
    const oldConfig = config(CURRENT_KEY);
    const oldEnvelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      payload: { prompt: SENSITIVE_TEXT },
      config: oldConfig,
    });
    const rotatedConfig = config(NEXT_KEY, CURRENT_KEY);

    expect(unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      envelope: oldEnvelope,
      config: rotatedConfig,
    })).toEqual({ prompt: SENSITIVE_TEXT });

    const newEnvelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      payload: { prompt: 'new-current-key' },
      config: rotatedConfig,
    });
    expect(newEnvelope.keyId).toBe(rotatedConfig.currentKeyId);
    expect(newEnvelope.keyId).not.toBe(oldEnvelope.keyId);

    const error = captureProtectionError(() => unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      envelope: newEnvelope,
      config: oldConfig,
    }));
    expect(error.code).toBe('BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED');
  });

  it.each([
    [
      'missing',
      {},
      'BACKSTAGE_JOB_PAYLOAD_CONFIG_MISSING',
    ],
    [
      'malformed',
      { [BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME]: 'not-canonical-base64' },
      'BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID',
    ],
    [
      'wrong length',
      { [BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME]: Buffer.alloc(31).toString('base64') },
      'BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID',
    ],
    [
      'current and previous collision',
      {
        [BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME]: CURRENT_KEY,
        [BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME]: CURRENT_KEY,
      },
      'BACKSTAGE_JOB_PAYLOAD_CONFIG_COLLISION',
    ],
    [
      'cross-purpose collision',
      {
        [BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME]: THIRD_KEY,
        ARCANOS_JOB_READ_CAPABILITY_SECRET: THIRD_KEY,
      },
      'BACKSTAGE_JOB_PAYLOAD_CONFIG_COLLISION',
    ],
  ] as const)('rejects %s key configuration', (_caseName, values, expectedCode) => {
    const error = captureProtectionError(() =>
      resolveBackstageJobPayloadProtectionConfig(environmentReader(values))
    );
    expect(error.code).toBe(expectedCode);
  });

  it('rejects non-strict envelopes before decryption', () => {
    const protectionConfig = config();
    const envelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      payload: { prompt: SENSITIVE_TEXT },
      config: protectionConfig,
    });

    const error = captureProtectionError(() => unsealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      envelope: { ...envelope, unexpected: true },
      config: protectionConfig,
    }));
    expect(error.code).toBe('BACKSTAGE_JOB_PAYLOAD_ENVELOPE_INVALID');
  });

  it('keeps secret, plaintext, and cipher material out of bounded typed errors', () => {
    const protectionConfig = config();
    const envelope = sealBackstageJobPayload({
      purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
      identity: inputIdentity,
      payload: { prompt: SENSITIVE_TEXT },
      config: protectionConfig,
    });
    const tamperedEnvelope: BackstageJobPayloadEnvelope = {
      ...envelope,
      ciphertext: mutateCanonicalBase64(envelope.ciphertext),
    };

    const errors = [
      captureProtectionError(() => unsealBackstageJobPayload({
        purpose: BACKSTAGE_JOB_PAYLOAD_INPUT_PURPOSE,
        identity: inputIdentity,
        envelope: tamperedEnvelope,
        config: protectionConfig,
      })),
      captureProtectionError(() => resolveBackstageJobPayloadProtectionConfig(
        environmentReader({
          [BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY_ENV_NAME]: CURRENT_KEY,
          [BACKSTAGE_BOOKER_JOB_PAYLOAD_PREVIOUS_KEY_ENV_NAME]: CURRENT_KEY,
        })
      )),
    ];

    for (const error of errors) {
      const publicError = `${error.name} ${error.code} ${error.message} ${JSON.stringify(error)}`;
      expect(error.message.length).toBeLessThanOrEqual(80);
      expect(publicError).not.toContain(CURRENT_KEY);
      expect(publicError).not.toContain(SENSITIVE_TEXT);
      expect(publicError).not.toContain(envelope.ciphertext);
      expect(publicError).not.toContain(envelope.iv);
      expect(publicError).not.toContain(envelope.authTag);
    }
  });
});
