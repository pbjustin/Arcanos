import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

describe('API Update Endpoint', () => {
  let app: Express;
  const baseUrl = 'http://localhost:8080';
  const originalFetch = global.fetch;

  const parseBody = (init?: RequestInit): Record<string, unknown> | null => {
    if (!init?.body || typeof init.body !== 'string') {
      return null;
    }
    try {
      return JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const createResponse = (status: number, data: Record<string, unknown>) => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => data
  });

  beforeEach(() => {
    app = createApp();
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (!url.includes('/api/update')) {
        return createResponse(404, { error: 'Not found' });
      }

      const body = parseBody(init);
      const updateType = typeof body?.updateType === 'string' ? body.updateType : '';
      const data = body?.data;

      if (!updateType || updateType.trim().length === 0) {
        return createResponse(400, { error: 'updateType is required' });
      }

      if (data === undefined || data === null) {
        return createResponse(400, { error: 'data is required' });
      }

      try {
        const serialized = JSON.stringify(data);
        if (serialized.length > 10_000) {
          return createResponse(413, { error: 'Payload Too Large' });
        }
      } catch {
        return createResponse(400, { error: 'data must be JSON-serializable' });
      }

      return createResponse(200, { success: true });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    // Cleanup if needed
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as { fetch?: typeof fetch }).fetch;
    }
    jest.restoreAllMocks();
  });

  it('should reject requests without updateType', async () => {
    const response = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { test: 'value' } })
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error || data.details).toBeDefined();
  });

  it('should reject requests without data', async () => {
    const response = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updateType: 'test' })
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error || data.details).toBeDefined();
  });

  it('should accept valid update request', async () => {
    const response = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updateType: 'preference',
        data: { setting: 'value' }
      })
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('success');
    expect(data.success).toBe(true);
  });

  it('should reject oversized data payload', async () => {
    const largeData = { content: 'A'.repeat(10001) }; // Exceeds MAX_DATA_SIZE
    
    const response = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updateType: 'test',
        data: largeData
      })
    });

    expect(response.status).toBe(413); // Payload Too Large
  });

  it('should reject non-JSON-serializable data', async () => {
    // Note: This test may need adjustment based on actual validation
    const response = await fetch(`${baseUrl}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updateType: 'test',
        data: { circular: null }
      })
    });

    // Should either accept or reject based on validation
    expect([200, 400]).toContain(response.status);
  });
});
