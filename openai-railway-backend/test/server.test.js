const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

process.env.NODE_ENV = 'test';
const app = require('../server');

test('GET /health returns OK', async () => {
  const res = await request(app).get('/health');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.text, 'OK');
});

test('memory module stores and retrieves values without DB', async () => {
  const payload = { action: 'set', key: 'foo', value: { a: 1 } };
  let res = await request(app).post('/memory').send(payload);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, {
    status: 'success',
    data: { status: 'stored', key: 'foo', value: { a: 1 } }
  });

  res = await request(app).post('/memory').send({ action: 'get', key: 'foo' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, {
    status: 'success',
    data: { key: 'foo', value: { a: 1 } }
  });
});

