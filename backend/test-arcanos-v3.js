/**
 * Test suite for ARCANOS Backend v3.0
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('🧪 Testing ARCANOS Backend v3.0...\n');

// Test function with timeout
async function testWithTimeout(testFn, timeout = 5000) {
  return Promise.race([
    testFn(),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Test timeout')), timeout)
    )
  ]);
}

// Test health endpoint
async function testHealthEndpoint() {
  try {
    const { stdout } = await execAsync('curl -s http://localhost:3000/health');
    const response = JSON.parse(stdout);
    
    if (response.status === 'healthy' && response.service === 'ARCANOS Backend v3.0') {
      console.log('✅ Health endpoint test passed');
      return true;
    } else {
      console.log('❌ Health endpoint test failed:', response);
      return false;
    }
  } catch (err) {
    console.log('❌ Health endpoint test failed:', err.message);
    return false;
  }
}

// Test identity map endpoint
async function testIdentityMapEndpoint() {
  try {
    const { stdout } = await execAsync('curl -s http://localhost:3000/get-identity-map');
    const response = JSON.parse(stdout);
    
    if (Array.isArray(response) && response.length === 3) {
      const expectedModules = ['tutor', 'gaming', 'booker'];
      const actualModules = response.map(m => m.module);
      
      if (expectedModules.every(m => actualModules.includes(m))) {
        console.log('✅ Identity map endpoint test passed');
        return true;
      } else {
        console.log('❌ Identity map endpoint test failed: Missing expected modules');
        return false;
      }
    } else {
      console.log('❌ Identity map endpoint test failed: Invalid response format');
      return false;
    }
  } catch (err) {
    console.log('❌ Identity map endpoint test failed:', err.message);
    return false;
  }
}

// Test query endpoint with known module
async function testQueryKnownModule() {
  try {
    const { stdout } = await execAsync(
      'curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" -d \'{"module": "tutor", "data": "Test query"}\''
    );
    const response = JSON.parse(stdout);
    
    if (response.module === 'ARCANOS:TUTOR' && response.fallback_used === false) {
      console.log('✅ Query known module test passed');
      return true;
    } else {
      console.log('❌ Query known module test failed:', response);
      return false;
    }
  } catch (err) {
    console.log('❌ Query known module test failed:', err.message);
    return false;
  }
}

// Test query endpoint with unknown module (fallback)
async function testQueryFallback() {
  try {
    const { stdout } = await execAsync(
      'curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" -d \'{"module": "unknown", "data": "Test fallback"}\''
    );
    const response = JSON.parse(stdout);
    
    if (response.module === 'ARCANOS:DEFAULT' && response.fallback_used === true) {
      console.log('✅ Query fallback test passed');
      return true;
    } else {
      console.log('❌ Query fallback test failed:', response);
      return false;
    }
  } catch (err) {
    console.log('❌ Query fallback test failed:', err.message);
    return false;
  }
}

// Test query endpoint validation
async function testQueryValidation() {
  try {
    const { stdout } = await execAsync(
      'curl -s -X POST http://localhost:3000/query -H "Content-Type: application/json" -d \'{"module": "tutor"}\''
    );
    const response = JSON.parse(stdout);
    
    if (response.error && response.error.includes('Data field is required')) {
      console.log('✅ Query validation test passed');
      return true;
    } else {
      console.log('❌ Query validation test failed:', response);
      return false;
    }
  } catch (err) {
    console.log('❌ Query validation test failed:', err.message);
    return false;
  }
}

// Run all tests
async function runTests() {
  let passedTests = 0;
  let totalTests = 5;
  
  console.log('Running tests against http://localhost:3000\n');
  
  const tests = [
    testHealthEndpoint,
    testIdentityMapEndpoint,
    testQueryKnownModule,
    testQueryFallback,
    testQueryValidation
  ];
  
  for (const test of tests) {
    try {
      const result = await testWithTimeout(test);
      if (result) passedTests++;
    } catch (err) {
      console.log('❌ Test failed with timeout or error:', err.message);
    }
  }
  
  console.log(`\n📊 Test Results: ${passedTests}/${totalTests} tests passed`);
  
  if (passedTests === totalTests) {
    console.log('🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('💥 Some tests failed!');
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});