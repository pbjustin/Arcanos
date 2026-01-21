import { describe, beforeAll, afterAll, it, expect } from '@jest/globals';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../src/app.js';

describe('Codebase access API', () => {
  let server: Server;
  let baseUrl: string;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = '';
    const app = createApp();
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.on('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    });
  });

  it('lists repository root contents', async () => {
    const response = await fetch(`${baseUrl}/api/codebase/tree`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.status).toBe('success');
    expect(Array.isArray(payload.data.entries)).toBe(true);
    const names = payload.data.entries.map((entry: { name: string }) => entry.name);
    expect(names).toContain('src');
    expect(names).toContain('package.json');
  });

  it('reads a repository file', async () => {
    const response = await fetch(`${baseUrl}/api/codebase/file?path=README.md&startLine=1&endLine=5`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.status).toBe('success');
    expect(payload.data.path).toBe('README.md');
    expect(payload.data.binary).toBe(false);
    expect(typeof payload.data.content).toBe('string');
    expect(payload.data.content).toContain('# Arcanos Backend');
    expect(payload.data.startLine).toBe(1);
    expect(payload.data.endLine).toBeGreaterThanOrEqual(1);
  });

  it('prevents path traversal outside repository', async () => {
    const response = await fetch(`${baseUrl}/api/codebase/file?path=../package.json`);
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.status).toBe('error');
    expect(payload.message).toContain('outside');
  });
});
