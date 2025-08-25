/**
 * Test for the new /arcanos-query endpoint
 */

import { execAsync } from '../node_modules/@types/node/index.js';
import { spawn } from 'child_process';

// Helper to run async exec
const { exec } = await import('child_process');
const { promisify } = await import('util');
const execPromise = promisify(exec);

/**
 * Test the /arcanos-query endpoint
 */
async function testArcanosQueryEndpoint() {
  console.log('🧪 [ENDPOINT TEST] Testing /arcanos-query endpoint...');
  
  let serverProcess;
  
  try {
    // Start the server
    console.log('🚀 [ENDPOINT TEST] Starting ARCANOS server...');
    serverProcess = spawn('node', ['dist/server.js'], {
      stdio: 'pipe',
      env: { ...process.env, PORT: '8081' }
    });
    
    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 3000));
    
    const baseUrl = 'http://localhost:8081';
    
    // Test the endpoint
    console.log('📤 [ENDPOINT TEST] Testing /arcanos-query endpoint...');
    
    const testPayload = {
      prompt: "Test the new ARCANOS query endpoint"
    };
    
    const curlCmd = `curl -s -X POST ${baseUrl}/arcanos-query -H "Content-Type: application/json" -d '${JSON.stringify(testPayload)}'`;
    const { stdout } = await execPromise(curlCmd);
    const response = JSON.parse(stdout);
    
    console.log('📥 [ENDPOINT TEST] Response received:');
    console.log(`   - Result: "${response.result?.substring(0, 100)}${response.result?.length > 100 ? '...' : ''}"`);
    console.log(`   - Active Model: ${response.activeModel}`);
    console.log(`   - Module: ${response.module}`);
    console.log(`   - Process Steps: ${response.meta?.processSteps?.length} steps`);
    
    // Validate response structure
    if (response.result && 
        response.activeModel === 'ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote' &&
        response.module === 'ArcanosQuery' &&
        response.meta?.processSteps?.length === 2) {
      console.log('✅ [ENDPOINT TEST] /arcanos-query endpoint: PASSED');
      return true;
    } else {
      console.log('❌ [ENDPOINT TEST] Invalid response structure:', response);
      return false;
    }
    
  } catch (error) {
    console.log('❌ [ENDPOINT TEST] Endpoint test failed:', error.message);
    return false;
  } finally {
    if (serverProcess) {
      console.log('🔄 [ENDPOINT TEST] Cleaning up server process...');
      serverProcess.kill('SIGTERM');
    }
  }
}

/**
 * Test validation for the endpoint
 */
async function testArcanosQueryValidation() {
  console.log('🧪 [ENDPOINT TEST] Testing validation...');
  
  let serverProcess;
  
  try {
    // Start the server
    serverProcess = spawn('node', ['dist/server.js'], {
      stdio: 'pipe',
      env: { ...process.env, PORT: '8082' }
    });
    
    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 3000));
    
    const baseUrl = 'http://localhost:8082';
    
    // Test with missing prompt
    const curlCmd = `curl -s -X POST ${baseUrl}/arcanos-query -H "Content-Type: application/json" -d '{}'`;
    const { stdout } = await execPromise(curlCmd);
    const response = JSON.parse(stdout);
    
    if (response.error && response.error.includes('prompt is required')) {
      console.log('✅ [ENDPOINT TEST] Validation working correctly');
      return true;
    } else {
      console.log('❌ [ENDPOINT TEST] Validation not working:', response);
      return false;
    }
    
  } catch (error) {
    console.log('❌ [ENDPOINT TEST] Validation test failed:', error.message);
    return false;
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

/**
 * Main test runner
 */
async function runEndpointTests() {
  console.log('🚀 [ENDPOINT TEST] Starting ARCANOS Query Endpoint Tests...\n');
  
  const results = [];
  
  // Test 1: Basic endpoint functionality
  console.log('1. Testing endpoint functionality...');
  results.push(await testArcanosQueryEndpoint());
  
  console.log('\n2. Testing validation...');
  results.push(await testArcanosQueryValidation());
  
  // Summary
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`\n📊 [ENDPOINT TEST] Results: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('🎉 [ENDPOINT TEST] All endpoint tests passed!');
    return true;
  } else {
    console.log('❌ [ENDPOINT TEST] Some endpoint tests failed');
    return false;
  }
}

// Run the tests
runEndpointTests().catch(error => {
  console.error('💥 [ENDPOINT TEST] Test runner crashed:', error);
  process.exit(1);
});