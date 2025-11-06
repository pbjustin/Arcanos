import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createApp } from '../src/app.js';

const originalApiKey = process.env.OPENAI_API_KEY;
const originalApiKeyAlias = process.env.API_KEY;

describe('AI endpoints in mock mode', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = '';
    process.env.API_KEY = '';
    const app = createApp();
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.on('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    process.env.OPENAI_API_KEY = originalApiKey;
    process.env.API_KEY = originalApiKeyAlias;
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(err => (err ? reject(err) : resolve()));
    });
  });

  it('returns structured mock response for /ask endpoint', async () => {
    const response = await fetch(`${baseUrl}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test prompt for mock mode' })
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result).toContain('[MOCK AI RESPONSE]');
    expect(payload.activeModel).toBe('MOCK');
    expect(payload.meta).toHaveProperty('id');
    expect(payload.meta).toHaveProperty('created');
    expect(payload.auditSafe).toBeDefined();
  });

  it('normalizes ChatGPT action payload through /api/ask', async () => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'How does the system behave?',
        domain: 'diagnostics',
        useRAG: true,
        useHRC: false
      })
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result).toContain('[MOCK AI RESPONSE]');
    expect(payload.routingStages).toContain('ARCANOS-INTAKE:MOCK');
  });

  it('provides deterministic mock diagnostics for /arcanos', async () => {
    const response = await fetch(`${baseUrl}/arcanos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-confirmed': 'yes' },
      body: JSON.stringify({ userInput: 'system inspection request' })
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.result).toContain('[MOCK ARCANOS RESPONSE]');
    expect(payload.componentStatus).toContain('MOCK');
    expect(payload.meta).toHaveProperty('id');
    expect(payload.meta).toHaveProperty('created');
  });
});
