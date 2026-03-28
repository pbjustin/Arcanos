import { beforeEach, describe, expect, it } from '@jest/globals';

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const aiRoutingDebugRouter = (await import('../src/routes/api-ai-routing-debug.js')).default;
const {
  clearAiRoutingDebugSnapshotsForTest,
  recordAiRoutingDebugSnapshot,
} = await import('../src/services/aiRoutingDebugService.js');

function buildApp() {
  const app = express();
  app.use(aiRoutingDebugRouter);
  return app;
}

describe('ai routing debug route', () => {
  beforeEach(() => {
    clearAiRoutingDebugSnapshotsForTest();
  });

  it('returns the latest routing debug snapshot', async () => {
    recordAiRoutingDebugSnapshot({
      requestId: 'req-ai-routing-1',
      timestamp: '2026-03-27T00:00:00.000Z',
      rawPrompt: 'Read live runtime state. Do not use repo inspection.',
      normalizedPrompt: 'Read live runtime state. Do not use repo inspection.',
      detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
      routingDecision: 'runtime_inspection_completed',
      toolsAvailable: ['/api/self-heal/runtime', 'cli:status', 'system.metrics'],
      toolsSelected: ['/api/self-heal/runtime', 'cli:status'],
      cliUsed: true,
      runtimeEndpointsQueried: ['/api/self-heal/runtime'],
      repoFallbackUsed: false,
      constraintViolations: [],
    });

    const app = buildApp();
    const response = await request(app).get('/api/ai-routing/debug/latest');

    expect(response.status).toBe(200);
    expect(response.body.latest).toMatchObject({
      requestId: 'req-ai-routing-1',
      detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
      cliUsed: true,
      repoFallbackUsed: false,
      toolsSelected: ['/api/self-heal/runtime', 'cli:status'],
    });
  });
});
