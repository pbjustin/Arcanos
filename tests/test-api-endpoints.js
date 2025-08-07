#!/usr/bin/env node

// Simple API endpoint tests against the ARCANOS server
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';

async function waitForServer(url, attempts = 10, delay = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      await execAsync(`curl -s ${url}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`Server did not start at ${url}`);
}

async function main() {
  console.log('🧪 Running basic API endpoint tests...');
  let allPassed = true;

  await waitForServer(`${BASE_URL}/health`);

  // Health endpoint
  try {
    const { stdout } = await execAsync(`curl -s ${BASE_URL}/health`);
    const health = JSON.parse(stdout);
    const ok = health.status === 'OK';
    console.log('Health endpoint:', ok ? '✅ PASSED' : '❌ FAILED');
    if (!ok) allPassed = false;
  } catch (err) {
    console.log('❌ Health endpoint test failed:', err.message);
    allPassed = false;
  }

  // Root endpoint
  try {
    const { stdout } = await execAsync(`curl -s ${BASE_URL}/`);
    const ok = stdout.trim().length > 0;
    console.log('Root endpoint:', ok ? '✅ PASSED' : '❌ FAILED');
    if (!ok) allPassed = false;
  } catch (err) {
    console.log('❌ Root endpoint test failed:', err.message);
    allPassed = false;
  }

  // Ask endpoint
  try {
    const { stdout } = await execAsync(`curl -s -X POST ${BASE_URL}/ask -H "Content-Type: application/json" -d '{"prompt":"test question"}'`);
    const resp = JSON.parse(stdout);
    const expectedModel = process.env.AI_MODEL || 'gpt-4';
    const ok = !!(resp.result || resp.error);
    const modelMatches = !resp.module || resp.module === expectedModel;
    console.log('Ask endpoint response:', ok && modelMatches ? '✅ PASSED' : '❌ FAILED');
    if (!ok || !modelMatches) {
      if (!modelMatches && resp.module) {
        console.log(`Expected model ${expectedModel} but received ${resp.module}`);
      }
      allPassed = false;
    }
  } catch (err) {
    console.log('❌ Ask endpoint test failed:', err.message);
    allPassed = false;
  }

  if (allPassed) {
    console.log('\n🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed!');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

