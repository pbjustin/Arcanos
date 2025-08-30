const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.NODE_ENV = 'test';
const app = require('../server');

test('POST /ask handles JSON payload', async () => {
  const res = await request(app)
    .post('/ask')
    .send({ module: 'ping', payload: {} });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.strictEqual(res.body.module, 'ping');
  assert.strictEqual(res.body.data.pong, true);
});

test('POST /ask handles raw text commands', async () => {
  const res = await request(app)
    .post('/ask')
    .set('Content-Type', 'text/plain')
    .send('echo hello');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'success');
  assert.strictEqual(res.body.module, 'shell');
  assert.strictEqual(res.body.data.stdout.trim(), 'hello');
});
