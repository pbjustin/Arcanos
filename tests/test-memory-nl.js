#!/usr/bin/env node

import assert from 'assert';

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runTests() {
  process.env.OPENAI_API_KEY = 'test-key';
  const mod = await import('../routes/memoryNl.js');
  const router = mod.default;
  const pool = mod.pool;
  const openai = mod.openai;

  const route = router.stack.find(
    (r) => r.route && r.route.path === '/nl'
  ).route.stack[0].handle;

  // Test 1: Parameterized query prevents injection
  openai.chat.completions.create = async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            where: 'module = $1',
            params: ["test'; DROP TABLE memory_logs;--"],
          }),
        },
      },
    ],
  });

  let capturedSQL = '';
  let capturedParams = [];
  pool.query = async (sql, params) => {
    capturedSQL = sql;
    capturedParams = params;
    return { rows: [] };
  };

  const req1 = { body: { query: 'module test' } };
  const res1 = createMockRes();
  await route(req1, res1);

  assert.ok(capturedSQL.includes('module = $1'));
  assert.deepStrictEqual(capturedParams, ["test'; DROP TABLE memory_logs;--"]);
  assert.strictEqual(res1.statusCode, 200);
  assert.deepStrictEqual(res1.body.results, []);
  console.log('✅ Parameterized query prevents injection');

  // Test 2: Error handling does not leak details
  openai.chat.completions.create = async () => ({
    choices: [
      { message: { content: JSON.stringify({ where: 'module = $1', params: ['foo'] }) } },
    ],
  });

  pool.query = async () => {
    throw new Error('sensitive internal error');
  };

  const req2 = { body: { query: 'module foo' } };
  const res2 = createMockRes();
  await route(req2, res2);

  assert.strictEqual(res2.statusCode, 500);
  assert.deepStrictEqual(res2.body, { error: 'Internal server error' });
  console.log('✅ Error handling does not leak details');
}

runTests().catch((err) => {
  console.error('❌ Test failed', err);
  process.exit(1);
});
