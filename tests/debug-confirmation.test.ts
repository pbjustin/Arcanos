import { describe, test, expect, beforeEach, beforeAll } from '@jest/globals';
import request from 'supertest';
import express, { Express } from 'express';

// Set environment variables before importing modules
process.env.ARCANOS_AUTOMATION_SECRET = 'test-secret-123';
process.env.ARCANOS_AUTOMATION_HEADER = 'x-automation-secret';

// Import after setting env
const { default: debugConfirmationRouter } = await import('../src/routes/debug-confirmation.js');

describe('debug-confirmation routes', () => {
  let app: Express;

  beforeAll(() => {
    // Ensure environment is set
    process.env.ARCANOS_AUTOMATION_SECRET = 'test-secret-123';
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-automation-secret';
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(debugConfirmationRouter);
  });

  describe('POST /debug/create-confirmation-token', () => {
    test('requires automation secret header', async () => {
      const response = await request(app)
        .post('/debug/create-confirmation-token')
        .expect(403);

      expect(response.body).toEqual({
        ok: false,
        error: 'Forbidden'
      });
    });

    test('rejects invalid automation secret', async () => {
      const response = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'wrong-secret')
        .expect(403);

      expect(response.body).toEqual({
        ok: false,
        error: 'Forbidden'
      });
    });

    test('creates token with valid automation secret', async () => {
      const response = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.token).toBeDefined();
      expect(typeof response.body.token).toBe('string');
      expect(response.body.issuedAt).toBeDefined();
      expect(response.body.expiresAt).toBeDefined();
      expect(response.body.ttlMs).toBeGreaterThan(0);
      expect(response.body.ttlConfiguredMs).toBeGreaterThan(0);
    });

    test('returns properly formatted timestamp fields', async () => {
      const response = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      // Verify ISO 8601 timestamp format
      expect(new Date(response.body.issuedAt).toISOString()).toBe(response.body.issuedAt);
      expect(new Date(response.body.expiresAt).toISOString()).toBe(response.body.expiresAt);
    });

    test('generates unique tokens on multiple requests', async () => {
      const response1 = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const response2 = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      expect(response1.body.token).not.toBe(response2.body.token);
    });
  });

  describe('POST /debug/consume-confirm-token', () => {
    test('requires automation secret header', async () => {
      const response = await request(app)
        .post('/debug/consume-confirm-token')
        .send({ token: 'some-token' })
        .expect(403);

      expect(response.body).toEqual({
        ok: false,
        error: 'Forbidden'
      });
    });

    test('rejects request without token', async () => {
      const response = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(400);

      expect(response.body).toEqual({
        ok: false,
        error: 'Missing token'
      });
    });

    test('accepts token from request body', async () => {
      // First create a token
      const createResponse = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const token = createResponse.body.token;

      // Then consume it
      const consumeResponse = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token })
        .expect(200);

      expect(consumeResponse.body.ok).toBe(true);
      expect(consumeResponse.body.consumed).toBe(true);
      expect(consumeResponse.body.issuedAt).toBeDefined();
      expect(consumeResponse.body.expiresAt).toBeDefined();
    });

    test('accepts token from header', async () => {
      // First create a token
      const createResponse = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const token = createResponse.body.token;

      // Then consume it via header
      const consumeResponse = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .set('x-arcanos-confirm-token', token)
        .expect(200);

      expect(consumeResponse.body.ok).toBe(true);
      expect(consumeResponse.body.consumed).toBe(true);
    });

    test('prevents token replay - token can only be consumed once', async () => {
      // Create a token
      const createResponse = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const token = createResponse.body.token;

      // First consumption should succeed
      await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token })
        .expect(200);

      // Second consumption should fail
      const secondResponse = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token })
        .expect(403);

      expect(secondResponse.body.ok).toBe(false);
      expect(secondResponse.body.error).toBe('Invalid or expired token');
      expect(secondResponse.body.reason).toBe('invalid');
    });

    test('rejects invalid token', async () => {
      const response = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token: 'invalid-token-xyz' })
        .expect(403);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Invalid or expired token');
      expect(response.body.reason).toBe('invalid');
    });

    test('prioritizes header token over body token', async () => {
      const createResponse = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const validToken = createResponse.body.token;

      // Send valid token in header, invalid in body
      const response = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .set('x-arcanos-confirm-token', validToken)
        .send({ token: 'invalid-body-token' })
        .expect(200);

      expect(response.body.ok).toBe(true);
    });
  });

  describe('Integration flow', () => {
    test('complete token lifecycle: create, consume, verify consumed', async () => {
      // 1. Create token
      const createResponse = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      expect(createResponse.body.ok).toBe(true);
      const token = createResponse.body.token;
      expect(token).toBeDefined();

      // 2. Consume token
      const consumeResponse = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token })
        .expect(200);

      expect(consumeResponse.body.ok).toBe(true);
      expect(consumeResponse.body.consumed).toBe(true);

      // 3. Verify token cannot be reused
      const reuseResponse = await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token })
        .expect(403);

      expect(reuseResponse.body.ok).toBe(false);
    });

    test('multiple tokens can be created and consumed independently', async () => {
      // Create multiple tokens
      const token1Response = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const token2Response = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const token3Response = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      const token1 = token1Response.body.token;
      const token2 = token2Response.body.token;
      const token3 = token3Response.body.token;

      // Verify tokens are unique
      expect(token1).not.toBe(token2);
      expect(token2).not.toBe(token3);
      expect(token1).not.toBe(token3);

      // Consume tokens in non-sequential order
      await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token: token2 })
        .expect(200);

      await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token: token1 })
        .expect(200);

      await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token: token3 })
        .expect(200);

      // Verify all tokens are now consumed
      await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token: token1 })
        .expect(403);
    });
  });

  describe('Security audit markers', () => {
    test('token issuance requires operator secret (audit marker present)', async () => {
      // Verify the audit comment assumption: issuance requires operator secret
      // Risk: token issuance without operator approval
      // Invariant: secret must match
      // Handling: reject 403 if missing/invalid

      await request(app)
        .post('/debug/create-confirmation-token')
        .expect(403);
    });

    test('token consumption validates capability (audit marker present)', async () => {
      // Verify the audit comment assumption: token itself is the capability
      // Risk: leaked token grants access
      // Invariant: token must be valid and unexpired
      // Handling: consume on success, 403 on failure

      const createResponse = await request(app)
        .post('/debug/create-confirmation-token')
        .set('x-automation-secret', 'test-secret-123')
        .expect(200);

      // Valid token consumption
      await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token: createResponse.body.token })
        .expect(200);

      // Invalid token rejection
      await request(app)
        .post('/debug/consume-confirm-token')
        .set('x-automation-secret', 'test-secret-123')
        .send({ token: 'leaked-invalid-token' })
        .expect(403);
    });
  });
});
