import { describe, beforeAll, it, expect } from '@jest/globals';

const externalBaseUrl = process.env.TEST_SERVER_BASE_URL?.trim();
const describeWithServer = externalBaseUrl ? describe : describe.skip;

describeWithServer('Codebase access API', () => {
  let baseUrl: string;

  beforeAll(async () => {
    if (!externalBaseUrl) {
      throw new Error('TEST_SERVER_BASE_URL is required for codebase API endpoint tests');
    }

    baseUrl = externalBaseUrl.replace(/\/$/, '');
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
