import { describe, beforeAll, beforeEach, afterAll, it, expect } from '@jest/globals';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createApp } from '../src/app.js';
import { resetSafetyRuntimeStateForTests } from '../src/services/safety/runtimeState.js';

const originalApiKey = process.env.OPENAI_API_KEY;
const originalApiKeyAlias = process.env.API_KEY;
const originalLegacyGptRoutes = process.env.LEGACY_GPT_ROUTES;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

describe('AI endpoints in mock mode', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = '';
    process.env.API_KEY = '';
    process.env.LEGACY_GPT_ROUTES = 'enabled';
    resetSafetyRuntimeStateForTests();
    const app = createApp();
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.on('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    resetSafetyRuntimeStateForTests();
  });

  afterAll(async () => {
    restoreEnv('OPENAI_API_KEY', originalApiKey);
    restoreEnv('API_KEY', originalApiKeyAlias);
    restoreEnv('LEGACY_GPT_ROUTES', originalLegacyGptRoutes);
    resetSafetyRuntimeStateForTests();
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(err => (err ? reject(err) : resolve()));
    });
  });

  it('returns structured mock response for the canonical /gpt/:gptId endpoint', async () => {
    const response = await fetch(`${baseUrl}/gpt/arcanos-daemon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'query', prompt: 'test prompt for mock mode' })
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result?.result).toContain('[MOCK RESPONSE]');
    expect(payload.result?.activeModel).toBe('MOCK');
    expect(payload._route?.requestId).toBeTruthy();
    expect(payload._route?.gptId).toBe('arcanos-daemon');
  });

  it('rejects body gptId overrides on the canonical route', async () => {
    const response = await fetch(`${baseUrl}/gpt/arcanos-daemon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        gptId: 'backstage-booker',
        prompt: 'How does the system behave?'
      })
    });

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error?.code).toBe('BODY_GPT_ID_FORBIDDEN');
  });

  it('proxies deprecated /arcanos traffic through the canonical GPT route', async () => {
    const response = await fetch(`${baseUrl}/arcanos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-confirmed': 'yes' },
      body: JSON.stringify({ userInput: 'system inspection request' })
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(response.headers.get('x-canonical-route')).toBe('/gpt/arcanos-core');
    expect(response.headers.get('x-route-deprecated')).toBe('true');
    expect(payload.ok).toBeUndefined();
    expect(payload._route).toBeUndefined();
    expect(payload.result).toContain('[MOCK ARCANOS RESPONSE]');
    expect(payload.componentStatus).toBeTruthy();
  });
});
