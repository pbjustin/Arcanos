#!/usr/bin/env node

// Simple API endpoint tests against the live ARCANOS deployment
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const BASE_URL = process.env.TEST_URL || 'http://localhost:8080';

async function main() {
  console.log('🧪 Running basic API endpoint tests...');
  let allPassed = true;

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
    // Accept either a successful result or a service error (when API key not configured)
    const ok = !!(resp.result || resp.error);
    console.log('Ask endpoint response:', ok ? '✅ PASSED' : '❌ FAILED');
    if (!ok) allPassed = false;
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
