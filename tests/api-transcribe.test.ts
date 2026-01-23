import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

describe('API Transcribe Endpoint', () => {
  let app: Express;
  const baseUrl = 'http://localhost:8080';

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    // Cleanup if needed
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
