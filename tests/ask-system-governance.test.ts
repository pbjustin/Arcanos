import express, { type Express } from 'express';
import request from 'supertest';
import askRouter from '../src/routes/ask.js';

let app: Express;
let previousNodeEnv: string | undefined;
let previousSystemModeBypass: string | undefined;

beforeAll(() => {
  //audit Assumption: system mode auth bypass is required for deterministic test execution; failure risk: unexpected 401 responses; expected invariant: bypass enabled only within this suite; handling strategy: set and restore env vars in lifecycle hooks.
  previousNodeEnv = process.env.NODE_ENV;
  previousSystemModeBypass = process.env.ENABLE_TEST_SYSTEM_MODE_BYPASS;
  process.env.NODE_ENV = 'test';
  process.env.ENABLE_TEST_SYSTEM_MODE_BYPASS = '1';
  app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', askRouter);
});

afterAll(() => {
  if (previousNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = previousNodeEnv;
  }

  if (previousSystemModeBypass === undefined) {
    delete process.env.ENABLE_TEST_SYSTEM_MODE_BYPASS;
  } else {
    process.env.ENABLE_TEST_SYSTEM_MODE_BYPASS = previousSystemModeBypass;
  }
});

describe('/ask governed system modes', () => {
  it('returns strict system_state payload', async () => {
    const res = await request(app).post('/ask').send({
      mode: 'system_state',
      metadata: { instanceId: 'jest-instance' }
    });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('system_state');
    expect(res.body.intent).toBeDefined();
    expect(res.body.routing).toBeDefined();
    expect(res.body.backend).toBeDefined();
    expect(res.body.stateFreshness).toBeDefined();
    expect(res.body.generatedAt).toBeDefined();
  });

  it('records chat intent and exposes it through system_state', async () => {
    const chatRes = await request(app).post('/ask').send({
      prompt: 'Implement governed backend mode dispatch in /ask'
    });

    expect(chatRes.status).toBe(200);

    const stateRes = await request(app).post('/ask').send({ mode: 'system_state' });
    expect(stateRes.status).toBe(200);
    expect(stateRes.body.intent.intentId).toBeTruthy();
    //audit Assumption: intent labels are normalized for safe persistence; failure risk: brittle exact-text assertions; expected invariant: label preserves semantic prefix with optional hash suffix; handling strategy: assert normalized pattern.
    expect(String(stateRes.body.intent.label)).toMatch(
      /^implement-governed-backend-mode-dispatch(?:-[a-f0-9]{8})?$/
    );
    expect(stateRes.body.intent.status).toBe('active');
  });

  it('returns 409 on intent optimistic lock mismatch', async () => {
    const stateRes = await request(app).post('/ask').send({ mode: 'system_state' });
    const currentVersion = Number(stateRes.body?.intent?.version || 1);

    const conflictRes = await request(app).post('/ask').send({
      mode: 'system_state',
      expectedVersion: currentVersion + 100,
      patch: { confidence: 0.9, phase: 'execution' }
    });

    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error).toBe('INTENT_VERSION_CONFLICT');
    expect(typeof conflictRes.body.currentVersion).toBe('number');
  });

  it('hard-fails invalid system_review input', async () => {
    const reviewRes = await request(app).post('/ask').send({ mode: 'system_review' });

    expect(reviewRes.status).toBe(400);
    expect(reviewRes.body.error).toBe('Validation failed');
  });
});
