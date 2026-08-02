import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const originalAllowAllGpts = process.env.ALLOW_ALL_GPTS;
process.env.ALLOW_ALL_GPTS = 'false';

const mockBookEvent = jest.fn();
const mockGenerateBooking = jest.fn();
const mockSaveStoryline = jest.fn();
const mockSimulateMatch = jest.fn();
const mockTrackStoryline = jest.fn();
const mockUpdateRoster = jest.fn();

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

function clearPurposeBoundCredentialEnvironment(): void {
  for (const environmentName of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
    delete process.env[environmentName];
  }
}

function configureControlPlane(): void {
  clearPurposeBoundCredentialEnvironment();
  process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
  process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:backstage-route';
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

describe('direct Backstage routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureControlPlane();
    mockBookEvent.mockResolvedValue('event-1');
    mockGenerateBooking.mockResolvedValue('storyline');
    mockSaveStoryline.mockResolvedValue(undefined);
    mockSimulateMatch.mockResolvedValue({ winner: 'A' });
    mockTrackStoryline.mockResolvedValue([{ beat: 'turn' }]);
    mockUpdateRoster.mockResolvedValue([{ name: 'A', overall: 90 }]);
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
    expect(response.body).toEqual({ success: true, storyline: 'storyline' });
    expect(mockGenerateBooking).toHaveBeenCalledWith('Book a rivalry');
    expect(mockSaveStoryline).toHaveBeenCalledWith('story-1', 'storyline');
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

  it('keeps simulation public while preserving its existing confirmation gate', async () => {
    const denied = await request(buildApp())
      .post('/backstage/simulate-match')
      .send({ match: { participants: ['A', 'B'] } });
    const accepted = await request(buildApp())
      .post('/backstage/simulate-match')
      .set('X-Confirmed', 'yes')
      .send({ match: { participants: ['A', 'B'] } });

    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ success: true, result: { winner: 'A' } });
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
