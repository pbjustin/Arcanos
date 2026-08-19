import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
  BackstageRosterPersistenceError,
} from '../src/shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
  BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
  BackstageStorylinePersistenceError,
} from '../src/shared/backstage/backstageStoryline.js';
import { BackstageNotionAuthorityReadOnlyError } from '../src/services/backstageBookerContracts.js';

const originalAllowAllGpts = process.env.ALLOW_ALL_GPTS;
process.env.ALLOW_ALL_GPTS = 'false';

const mockBookEvent = jest.fn();
const mockGenerateBooking = jest.fn();
const mockSaveStoryline = jest.fn();
const mockSimulateMatch = jest.fn();
const mockTrackStoryline = jest.fn();
const mockUpdateRoster = jest.fn();
const mockIsBackstageNotionAuthoritativeUniverse = jest.fn();
const durablePersistence = {
  status: 'durable',
  durable: true,
  backend: 'postgresql',
  degraded: false
};

jest.unstable_mockModule('@services/backstage-booker.js', () => ({
  BackstageBooker: {
    bookEvent: mockBookEvent,
    generateBooking: mockGenerateBooking,
    saveStoryline: mockSaveStoryline,
    simulateMatch: mockSimulateMatch,
    trackStoryline: mockTrackStoryline,
    updateRoster: mockUpdateRoster,
  },
}));

jest.unstable_mockModule('@services/backstageNotionAuthority.js', () => ({
  isBackstageNotionAuthorityEnforced: mockIsBackstageNotionAuthoritativeUniverse
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const backstageRouter = (await import('../src/routes/backstage.js')).default;
const {
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
} = await import('../src/shared/security/purposeBoundCredential.js');

const controlPlaneToken = 'backstage-route-control-token-1234567890';
const originalCredentialEnvironment = new Map(
  PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.map(
    (environmentName) => [environmentName, process.env[environmentName]] as const
  )
);
const originalPrincipalId = process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
const originalScopes = process.env.ARCANOS_CONTROL_PLANE_SCOPES;
let testPrincipalSequence = 0;

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  testPrincipalSequence += 1;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = `operator:backstage-route:${testPrincipalSequence}`;
  process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'mcp:invoke';
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/backstage', backstageRouter);
  return app;
}

function authorizedConfirmedPost(path: string) {
  return request(buildApp())
    .post(path)
    .set('Authorization', `Bearer ${controlPlaneToken}`)
    .set('X-Confirmed', 'yes');
}

function storylineBeatAtSerializedBytes(totalBytes: number): Record<string, unknown> {
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ detail: '' }), 'utf8');
  return { detail: 'x'.repeat(totalBytes - envelopeBytes) };
}

describe('direct Backstage routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    mockBookEvent.mockResolvedValue({
      universeId: 'legacy',
      eventId: 'event-1',
      persistence: durablePersistence
    });
    mockGenerateBooking.mockResolvedValue('storyline');
    mockSaveStoryline.mockResolvedValue({
      universeId: 'legacy',
      key: 'story-1',
      saved: true,
      persistence: durablePersistence
    });
    mockSimulateMatch.mockResolvedValue({
      universeId: 'legacy',
      result: {
        match: 'A vs B (Singles)',
        winner: 'A',
        loser: 'B',
        probability: { A: '0.50', B: '0.50' },
        interference: null,
        rating: '4.0'
      },
      hrc: { fidelity: 1, resilience: 1, verdict: 'PASS' }
    });
    mockTrackStoryline.mockResolvedValue({
      universeId: 'legacy',
      beats: [{ beat: 'turn' }],
      persistence: durablePersistence
    });
    mockUpdateRoster.mockResolvedValue({
      universeId: 'legacy',
      roster: [{ name: 'A', overall: 90 }],
      persistence: durablePersistence
    });
    mockIsBackstageNotionAuthoritativeUniverse.mockReturnValue(false);
  });

  it.each([
    ['/backstage/book-event', { name: 'Event' }, mockBookEvent],
    ['/backstage/book-gpt', { prompt: 'Book a rivalry' }, mockGenerateBooking],
    ['/backstage/track-storyline', { beat: 'turn' }, mockTrackStoryline],
    ['/backstage/update-roster', [{ name: 'A', overall: 90 }], mockUpdateRoster],
  ] as const)('rejects confirmed but anonymous mutation %s', async (path, body, handler) => {
    const response = await request(buildApp())
      .post(path)
      .set('X-Confirmed', 'yes')
      .send(body);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(handler).not.toHaveBeenCalled();
    expect(mockSaveStoryline).not.toHaveBeenCalled();
  });

  it('runs book-gpt only after operator admission and confirmation', async () => {
    const response = await authorizedConfirmedPost('/backstage/book-gpt')
      .send({ prompt: 'Book a rivalry', key: 'story-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      storyline: 'storyline',
      universeId: 'legacy',
      key: 'story-1',
      saved: true,
      persistence: durablePersistence
    });
    expect(mockGenerateBooking).toHaveBeenCalledWith('Book a rivalry', 'legacy');
    expect(mockSaveStoryline).toHaveBeenCalledWith('story-1', 'storyline', 'legacy');
  });

  it('denies a Notion-authoritative book-gpt request before generation', async () => {
    const universeId = 'notion-authoritative-universe';
    mockIsBackstageNotionAuthoritativeUniverse.mockImplementation(
      (candidateUniverseId: string) => candidateUniverseId === universeId
    );

    const response = await authorizedConfirmedPost('/backstage/book-gpt').send({
      universeId,
      prompt: 'Book a protected rivalry.',
      key: 'protected-story',
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: 'BACKSTAGE_NOTION_AUTHORITY_READ_ONLY',
        message: new BackstageNotionAuthorityReadOnlyError(universeId).message,
        retryable: false,
      },
    });
    expect(mockGenerateBooking).not.toHaveBeenCalled();
    expect(mockSaveStoryline).not.toHaveBeenCalled();
  });

  it('forwards an explicit universe and preserves the eventID alias', async () => {
    mockBookEvent.mockResolvedValueOnce({
      universeId: 'wwe-alt-2026',
      eventId: 'event-alt-1',
      persistence: durablePersistence
    });

    const response = await authorizedConfirmedPost('/backstage/book-event').send({
      universeId: 'wwe-alt-2026',
      event: { name: 'SummerSlam' }
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      universeId: 'wwe-alt-2026',
      eventId: 'event-alt-1',
      eventID: 'event-alt-1',
      persistence: durablePersistence
    });
    expect(mockBookEvent).toHaveBeenCalledWith(
      { name: 'SummerSlam' },
      'wwe-alt-2026'
    );
  });

  it('preserves open event-domain fields instead of treating event as a wrapper', async () => {
    mockBookEvent.mockResolvedValueOnce({
      universeId: 'raw-event-fields',
      eventId: 'event-raw-1',
      persistence: durablePersistence
    });
    const event = {
      event: 'WrestleMania',
      venue: 'Allegiant Stadium',
      action: 'announce-card',
      context: { brand: 'Raw' },
      mode: 'canon',
      hrc: { requested: true }
    };

    const response = await authorizedConfirmedPost('/backstage/book-event').send({
      universeId: 'raw-event-fields',
      ...event
    });

    expect(response.status).toBe(200);
    expect(mockBookEvent).toHaveBeenCalledWith(event, 'raw-event-fields');
  });

  it('accepts a valid direct event larger than the storyline beat limit', async () => {
    const event = {
      name: 'Two-night stadium event',
      productionNotes: 'x'.repeat(20 * 1024)
    };

    const response = await authorizedConfirmedPost('/backstage/book-event').send(event);

    expect(Buffer.byteLength(JSON.stringify(event), 'utf8'))
      .toBeGreaterThan(BACKSTAGE_STORYLINE_MAX_BYTES);
    expect(response.status).toBe(200);
    expect(mockBookEvent).toHaveBeenCalledWith(event, 'legacy');
  });

  it('preserves open beat-domain fields instead of treating beat as a wrapper', async () => {
    mockTrackStoryline.mockResolvedValueOnce({
      universeId: 'raw-beat-fields',
      beats: [{ beat: 'turn', venue: 'backstage' }],
      persistence: durablePersistence
    });
    const beat = {
      beat: 'turn',
      venue: 'backstage',
      action: 'betrayal',
      context: { target: 'champion' },
      mode: 'canon',
      hrc: { requested: true }
    };

    const response = await authorizedConfirmedPost('/backstage/track-storyline').send({
      universeId: 'raw-beat-fields',
      ...beat
    });

    expect(response.status).toBe(200);
    expect(mockTrackStoryline).toHaveBeenCalledWith(beat, 'raw-beat-fields');
  });

  it('preserves an exact object-valued event field without explicit universe scope', async () => {
    const event = { event: { name: 'Raw' } };

    const response = await authorizedConfirmedPost('/backstage/book-event').send(event);

    expect(response.status).toBe(200);
    expect(mockBookEvent).toHaveBeenCalledWith(event, 'legacy');
  });

  it('preserves an exact object-valued beat field without explicit universe scope', async () => {
    const beat = { beat: { turn: 'heel' } };

    const response = await authorizedConfirmedPost('/backstage/track-storyline').send(beat);

    expect(response.status).toBe(200);
    expect(mockTrackStoryline).toHaveBeenCalledWith(beat, 'legacy');
  });

  it.each([
    ['blank', '   '],
    ['non-string', 42],
    ['oversized', 'x'.repeat(241)]
  ] as const)('validates a %s optional storyline key before generation effects', async (_label, key) => {
    const response = await request(buildApp())
      .post('/backstage/book-gpt')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ prompt: 'Book a rivalry', key });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      action: 'saveStoryline'
    }));
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(response.headers['x-confirmation-status']).toBeUndefined();
    expect(mockGenerateBooking).not.toHaveBeenCalled();
    expect(mockSaveStoryline).not.toHaveBeenCalled();
  });

  it('rejects invalid universe ids before invoking the service', async () => {
    const response = await request(buildApp())
      .post('/backstage/book-event')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({
        universeId: '../cross-universe',
        event: { name: 'Forbidden Door' }
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      action: 'bookEvent',
      issues: expect.any(Array)
    }));
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(response.headers['x-confirmation-status']).toBeUndefined();
    expect(mockBookEvent).not.toHaveBeenCalled();
  });

  it('requires confirmation after operator admission', async () => {
    const response = await request(buildApp())
      .post('/backstage/update-roster')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send([{ name: 'A', overall: 90 }]);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(mockUpdateRoster).not.toHaveBeenCalled();
  });

  it('updates a valid roster after operator admission and confirmation', async () => {
    const payload = [{ name: 'A', overall: 90 }];

    const response = await authorizedConfirmedPost('/backstage/update-roster')
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      universeId: 'legacy',
      roster: payload,
      persistence: durablePersistence
    });
    expect(mockUpdateRoster).toHaveBeenCalledWith(payload, 'legacy');
  });

  it('maps typed roster validation failures to a stable client error', async () => {
    const response = await request(buildApp())
      .post('/backstage/update-roster')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ name: 'not-an-array', overall: 90 });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
        message: 'Roster payload must be an array.'
      }
    });
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(response.headers['x-confirmation-status']).toBeUndefined();
    expect(mockUpdateRoster).not.toHaveBeenCalled();
  });

  it('maps invalid storyline input before issuing a confirmation challenge', async () => {
    const response = await request(buildApp())
      .post('/backstage/track-storyline')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send([]);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
        message: 'Storyline beat payload must be a JSON object.'
      }
    });
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(response.headers['x-confirmation-status']).toBeUndefined();
    expect(mockTrackStoryline).not.toHaveBeenCalled();
  });

  it('requires confirmation for a canonical beat at the inner payload byte limit', async () => {
    const beat = storylineBeatAtSerializedBytes(BACKSTAGE_STORYLINE_MAX_BYTES);

    const response = await request(buildApp())
      .post('/backstage/track-storyline')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send({ universeId: 'boundary-universe', beat });

    expect(Buffer.byteLength(JSON.stringify(beat), 'utf8'))
      .toBe(BACKSTAGE_STORYLINE_MAX_BYTES);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(response.headers['x-confirmation-challenge']).toEqual(expect.any(String));
    expect(mockTrackStoryline).not.toHaveBeenCalled();
  });

  it('maps authoritative roster persistence failures to a stable unavailable response', async () => {
    mockUpdateRoster.mockRejectedValueOnce(new BackstageRosterPersistenceError());

    const response = await authorizedConfirmedPost('/backstage/update-roster')
      .send([{ name: 'A', overall: 90 }]);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE,
        message: 'Roster update persistence could not be confirmed.'
      }
    });
    expect(mockUpdateRoster).toHaveBeenCalledWith([{ name: 'A', overall: 90 }], 'legacy');
  });

  it('maps authoritative storyline persistence failures to a stable unavailable response', async () => {
    mockTrackStoryline.mockRejectedValueOnce(new BackstageStorylinePersistenceError());

    const response = await authorizedConfirmedPost('/backstage/track-storyline')
      .send({ beat: 'turn' });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      success: false,
      error: {
        code: BACKSTAGE_STORYLINE_PERSISTENCE_ERROR_CODE,
        message: 'Storyline persistence could not be confirmed.'
      }
    });
    expect(mockTrackStoryline).toHaveBeenCalledWith({ beat: 'turn' }, 'legacy');
  });

  it('does not replay a direct mutation challenge across control-plane principals', async () => {
    const app = buildApp();
    const body = { name: 'Event' };
    const replayControlPlaneToken = 'backstage-route-replay-token-1234567890';
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:backstage-route-a';

    const challengeResponse = await request(app)
      .post('/backstage/book-event')
      .set('Authorization', `Bearer ${controlPlaneToken}`)
      .send(body);
    const challengeId = challengeResponse.headers['x-confirmation-challenge'];

    expect(challengeResponse.status).toBe(403);
    expect(challengeId).toEqual(expect.any(String));

    process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = replayControlPlaneToken;
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:backstage-route-b';
    const replayResponse = await request(app)
      .post('/backstage/book-event')
      .set('Authorization', `Bearer ${replayControlPlaneToken}`)
      .set('X-Confirmed', `token:${challengeId}`)
      .send(body);

    expect(replayResponse.status).toBe(403);
    expect(replayResponse.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(replayResponse.body.confirmationChallenge.providedTokenStatus).toBe('invalid');
    expect(replayResponse.headers['x-confirmation-status']).toBe('pending');
    expect(mockBookEvent).not.toHaveBeenCalled();
  });

  it('keeps simulation public while preserving its existing confirmation gate', async () => {
    const denied = await request(buildApp())
      .post('/backstage/simulate-match')
      .send({ match: { wrestler1: 'A', wrestler2: 'B', matchType: 'Singles' } });
    const accepted = await request(buildApp())
      .post('/backstage/simulate-match')
      .set('X-Confirmed', 'yes')
      .send({ match: { wrestler1: 'A', wrestler2: 'B', matchType: 'Singles' } });

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({
      success: true,
      universeId: 'legacy',
      result: expect.objectContaining({
        winner: 'A',
        hrc: { fidelity: 1, resilience: 1, verdict: 'PASS' }
      }),
      matchResult: expect.objectContaining({ winner: 'A' }),
      hrc: { fidelity: 1, resilience: 1, verdict: 'PASS' }
    });
    expect(mockSimulateMatch).toHaveBeenCalledTimes(1);
  });
});

afterAll(() => {
  clearPurposeBoundCredentialEnvironment();
  for (const [environmentName, value] of originalCredentialEnvironment) {
    if (value !== undefined) {
      process.env[environmentName] = value;
    }
  }
  if (originalPrincipalId === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = originalPrincipalId;
  }
  if (originalScopes === undefined) {
    delete process.env.ARCANOS_CONTROL_PLANE_SCOPES;
  } else {
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = originalScopes;
  }
  if (originalAllowAllGpts === undefined) {
    delete process.env.ALLOW_ALL_GPTS;
  } else {
    process.env.ALLOW_ALL_GPTS = originalAllowAllGpts;
  }
});
