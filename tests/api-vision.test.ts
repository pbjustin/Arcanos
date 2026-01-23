import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

describe('API Vision Endpoint', () => {
  let app: Express;
  const baseUrl = 'http://localhost:8080';

  beforeEach(() => {
    app = createApp();
  });

  afterEach(() => {
    // Cleanup if needed
  });

  it('should reject requests without imageBase64', async () => {
    const response = await fetch(`${baseUrl}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'Describe this image' })
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error || data.details).toBeDefined();
  });

  it('should accept valid vision request with imageBase64', async () => {
    // Use a minimal valid base64 image (1x1 transparent PNG)
    const minimalImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    
    const response = await fetch(`${baseUrl}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: minimalImage,
        prompt: 'What is in this image?'
      })
    });

    // Should either succeed (if OpenAI key configured) or return 503 (service unavailable)
    expect([200, 503]).toContain(response.status);
    
    if (response.status === 200) {
      const data = await response.json();
      expect(data).toHaveProperty('response');
      expect(data).toHaveProperty('tokens');
      expect(data).toHaveProperty('cost');
      expect(data).toHaveProperty('model');
    }
  });

  it('should accept optional parameters (temperature, model, maxTokens)', async () => {
    const minimalImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    
    const response = await fetch(`${baseUrl}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: minimalImage,
        prompt: 'Describe this',
        temperature: 0.5,
        model: 'gpt-4o',
        maxTokens: 100
      })
    });

    expect([200, 400, 503]).toContain(response.status);
  });

  it('should reject oversized imageBase64', async () => {
    const oversizedImage = 'A'.repeat(8_000_001); // Exceeds MAX_IMAGE_BASE64_LENGTH
    
    const response = await fetch(`${baseUrl}/api/vision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: oversizedImage
      })
    });

    expect(response.status).toBe(400);
  });
});
