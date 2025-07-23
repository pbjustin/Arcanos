#!/usr/bin/env node

// Simple test for /api/ask concurrency limiter
const axios = require('axios');

const BASE_URL = process.env.TEST_URL || 'http://localhost:8080/api';
const TOTAL_REQUESTS = Number(process.env.TOTAL_REQUESTS || 10); // send more than limit

const DELAY = Number(process.env.DELAY || 0);

async function send(index) {
  try {
    const res = await axios.post(
      `${BASE_URL}/ask?delay=${DELAY}`,
      { query: `test-${index}` },
      { validateStatus: () => true }
    );
    console.log(`#${index} -> status ${res.status}`);
    return res.status;
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
