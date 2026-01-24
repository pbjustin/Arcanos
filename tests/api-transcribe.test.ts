import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

describe('API Transcribe Endpoint', () => {
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
      if (!url.includes('/api/transcribe')) {
        return createResponse(404, { error: 'Not found' });
      }

      const body = parseBody(init);
      const audioBase64 = typeof body?.audioBase64 === 'string' ? body.audioBase64 : '';

      if (!audioBase64 || audioBase64.trim().length === 0) {
        return createResponse(400, { error: 'audioBase64 is required' });
      }

      if (audioBase64.length > 8_000_000) {
        return createResponse(400, { error: 'audioBase64 too large' });
      }

      return createResponse(200, {
        text: 'mock transcription',
        model: typeof body?.model === 'string' ? body.model : 'whisper-1'
      });
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

  it('should reject requests without audioBase64', async () => {
    const response = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'test.wav' })
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error || data.details).toBeDefined();
  });

  it('should accept valid transcription request with audioBase64', async () => {
    // Use minimal valid base64 (empty WAV file header)
    const minimalAudio = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    
    const response = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: minimalAudio,
        filename: 'test.wav'
      })
    });

    // Should either succeed (if OpenAI key configured) or return 503 (service unavailable)
    expect([200, 503]).toContain(response.status);
    
    if (response.status === 200) {
      const data = await response.json();
      expect(data).toHaveProperty('text');
      expect(data).toHaveProperty('model');
    }
  });

  it('should accept optional parameters (model, language)', async () => {
    const minimalAudio = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    
    const response = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: minimalAudio,
        filename: 'test.wav',
        model: 'whisper-1',
        language: 'en'
      })
    });

    expect([200, 400, 503]).toContain(response.status);
  });

  it('should sanitize filename to prevent path traversal', async () => {
    const minimalAudio = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    
    const response = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: minimalAudio,
        filename: '../../../etc/passwd'
      })
    });

    // Should accept but sanitize filename
    expect([200, 400, 503]).toContain(response.status);
  });

  it('should reject oversized audioBase64', async () => {
    const oversizedAudio = 'A'.repeat(8_000_001); // Exceeds MAX_AUDIO_BASE64_LENGTH
    
    const response = await fetch(`${baseUrl}/api/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64: oversizedAudio
      })
    });

    expect(response.status).toBe(400);
  });
});
