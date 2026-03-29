import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockBuildSelfHealRuntimeSnapshot = jest.fn();
const mockBuildSelfHealEventsSnapshot = jest.fn();
const mockBuildSelfHealInspectionSnapshot = jest.fn();

jest.unstable_mockModule('@transport/http/middleware/capabilityGate.js', () => ({
  capabilityGate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.unstable_mockModule('@services/selfImprove/predictiveHealingService.js', () => ({
  runPredictiveHealingDecision: jest.fn(),
}));

jest.unstable_mockModule('@services/selfHealRuntimeInspectionService.js', () => ({
  buildSelfHealRuntimeSnapshot: mockBuildSelfHealRuntimeSnapshot,
  buildSelfHealEventsSnapshot: mockBuildSelfHealEventsSnapshot,
  buildSelfHealInspectionSnapshot: mockBuildSelfHealInspectionSnapshot,
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const selfHealRouter = (await import('../src/routes/self-heal.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(selfHealRouter);
  return app;
}

describe('self-heal runtime routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildSelfHealRuntimeSnapshot.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      loopStatus: { loopRunning: true },
    });
    mockBuildSelfHealEventsSnapshot.mockReturnValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      count: 1,
      events: [{ id: 'evt-1' }],
    });
    mockBuildSelfHealInspectionSnapshot.mockResolvedValue({
      status: 'ok',
      timestamp: '2026-03-27T00:00:00.000Z',
      summary: 'Collected 1 self-heal runtime event.',
      evidence: {
        selfHealRuntimeSnapshot: {
          status: 'ok',
          lastDecision: 'observe',
        },
        recentSelfHealEvents: [{ ts: '2026-03-27T00:00:00.000Z', type: 'AI_DIAGNOSIS_REQUEST' }],
        recentPromptDebugEvents: [],
        recentAIRoutingEvents: [],
        recentWorkerEvidence: [],
      },
      limits: {
        selfHealEvents: 10,
        promptDebugEvents: 10,
        aiRoutingEvents: 10,
        workerEvidence: 10,
      },
    });
  });

  it('exposes self-heal runtime and event snapshots', async () => {
    const app = buildApp();

    const runtimeResponse = await request(app).get('/api/self-heal/runtime');
    expect(runtimeResponse.status).toBe(200);
    expect(runtimeResponse.body).toMatchObject({
      status: 'ok',
      loopStatus: { loopRunning: true },
    });

    const eventsResponse = await request(app).get('/api/self-heal/events?limit=5');
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.body).toMatchObject({
      status: 'ok',
      count: 1,
      events: [{ id: 'evt-1' }],
    });
    expect(mockBuildSelfHealEventsSnapshot).toHaveBeenCalledWith(5);

    const inspectionResponse = await request(app).get('/api/self-heal/inspection?limit=7');
    expect(inspectionResponse.status).toBe(200);
    expect(inspectionResponse.body).toMatchObject({
      status: 'ok',
      evidence: {
        selfHealRuntimeSnapshot: {
          lastDecision: 'observe',
        },
        recentSelfHealEvents: [{ type: 'AI_DIAGNOSIS_REQUEST' }],
      },
    });
    expect(mockBuildSelfHealInspectionSnapshot).toHaveBeenCalledWith(7);
  });
});
