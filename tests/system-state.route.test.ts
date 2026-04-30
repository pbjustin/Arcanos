import express from 'express';
import request from 'supertest';

import { recordChatIntent } from '../src/routes/ask/intent_store.js';
import systemStateRouter from '../src/routes/system-state.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(systemStateRouter);
  return app;
}

describe('direct system-state route', () => {
  it('serves system_state through the direct endpoint', async () => {
    const response = await request(buildApp()).get('/system-state');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        mode: 'system_state',
        intent: expect.objectContaining({
          version: expect.any(Number),
        }),
        routing: expect.objectContaining({
          preferred: 'backend',
        }),
      })
    );
  });

  it('applies optimistic updates without using the GPT writing route', async () => {
    const sessionId = `system-state-route-update-${Date.now()}`;
    const seeded = recordChatIntent('Seed direct system-state route test', sessionId);
    const before = await request(buildApp()).get('/system-state').query({ sessionId });

    expect(before.status).toBe(200);
    expect(before.body.intent.version).toBe(seeded.version);

    const update = await request(buildApp())
      .post('/system-state')
      .send({
        sessionId,
        expectedVersion: seeded.version,
        patch: {
          status: 'active',
          phase: 'execution',
          label: 'route-direct-state',
        },
      });

    expect(update.status).toBe(200);
    expect(update.body).toEqual(
      expect.objectContaining({
        mode: 'system_state',
        intent: expect.objectContaining({
          status: 'active',
          phase: 'execution',
          label: 'route-direct-state',
        }),
      })
    );
  });

  it('returns structured errors for invalid update payloads', async () => {
    const response = await request(buildApp())
      .post('/system-state')
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'BAD_REQUEST',
        }),
      })
    );
  });
});
