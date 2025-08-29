/**
 * Basic smoke tests for ARCANOS Backend v4.0
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('🧪 Testing ARCANOS Backend v4.0...\n');

async function testHealthEndpoint() {
  try {
    const { stdout } = await execAsync('curl -s http://localhost:3000/health');
    const response = JSON.parse(stdout);
    if (response.status === 'healthy') {
      console.log('✅ Health endpoint');
      return true;
    }
    console.log('❌ Health endpoint', response);
    return false;
  } catch (err) {
    console.log('❌ Health endpoint', err.message);
    return false;
  }
}

async function testRoutingMeta() {
  try {
    const { stdout } = await execAsync('curl -s http://localhost:3000/gpt-routing-meta');
    const response = JSON.parse(stdout);
    if (Array.isArray(response) && response.length >= 3) {
      console.log('✅ Routing meta endpoint');
      return true;
    }
    console.log('❌ Routing meta endpoint', response);
    return false;
  } catch (err) {
    console.log('❌ Routing meta endpoint', err.message);
    return false;
  }
}

async function runTests() {
  const results = await Promise.all([testHealthEndpoint(), testRoutingMeta()]);
  const passed = results.filter(Boolean).length;
  console.log(`\n📊 Test Results: ${passed}/2 passed`);
  process.exit(passed === 2 ? 0 : 1);
}

runTests().catch(err => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
