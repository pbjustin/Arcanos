#!/usr/bin/env node

// Simple test for /api/ask concurrency limiter
const { validateSyntax } = require('./test-utils/validate');
let makeAxiosRequest;
try {
  ({ makeAxiosRequest } = require('./test-utils/common'));
} catch (err) {
  console.error('❌ Failed to load test utilities:', err.message);
  process.exit(1);
}

if (!validateSyntax(__filename)) {
  process.exit(1);
}

const TOTAL_REQUESTS = Number(process.env.TOTAL_REQUESTS || 10); // send more than limit
const DELAY = Number(process.env.DELAY || 0);

async function send(index) {
  try {
    const result = await makeAxiosRequest('POST', `/api/ask?delay=${DELAY}`, {
      data: { query: `test-${index}` }
    });
    const status = result.status || (result.success ? 200 : 500);
    console.log(`#${index} -> status ${status}`);
    return status;
  } catch (err) {
    console.error(`#${index} -> network error`, err.message);
    return 0;
  }
}

(async () => {
  const tasks = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    tasks.push(send(i));
  }

  const statuses = await Promise.all(tasks);
  const rejected = statuses.filter(s => s === 429).length;
  console.log('429 responses:', rejected);
  if (rejected > 0) {
    console.log('✅ Concurrency limiter is working');
  } else {
    console.log('❌ Concurrency limiter did not return any 429 responses');
  }
})();
