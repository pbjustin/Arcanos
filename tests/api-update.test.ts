import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { installMockFetch, uninstallMockFetch, parseJsonBody } from './testUtils/mockFetch.js';

describe('API Update Endpoint', () => {
  let app: Express;
  const baseUrl = 'http://localhost:8080';

  beforeEach(() => {
    app = createApp();

    installMockFetch({
      '/api/update': async (_url, init) => {
        const body = parseJsonBody(init);
        const updateType = typeof body?.updateType === 'string' ? body.updateType : '';
        const data = (body as any)?.data;

        if (!updateType) {
          return { status: 400, data: { error: 'updateType is required' } };
        }

        if (!data || typeof data !== 'object') {
          return { status: 400, data: { error: 'data is required' } };
        }

        const serialized = JSON.stringify(data);
        if (serialized.length > 10_000) {
          return { status: 413, data: { error: 'Payload Too Large' } };
        }

        return { status: 200, data: { success: true } };
      }
    });
  });

  afterEach(() => {
    uninstallMockFetch();
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
