#!/usr/bin/env node
/**
 * ARCANOS SDK Test Suite
 * 
 * Tests the OpenAI SDK interface functionality
 */

import { spawn } from 'child_process';

const SERVER_URL = 'http://localhost:8080';
let serverProcess = null;

// Test utilities
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function makeRequest(endpoint, options = {}) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.stringify(options.body) : undefined;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  const url = `${SERVER_URL}${endpoint}`;
  
  try {
    const response = await fetch(url, {
      method,
      headers: body ? headers : undefined,
      body
    });
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    } else {
      return await response.text();
    }
  } catch (error) {
    throw new Error(`Request failed: ${error.message}`);
  }
}

async function startServer() {
  console.log('🚀 Starting ARCANOS server...');
  
  serverProcess = spawn('node', ['dist/server.js'], {
    stdio: 'pipe',
    cwd: process.cwd()
  });

  // Wait for server to start
  await delay(3000);
  
  // Check if server is running
  try {
    await makeRequest('/health');
    console.log('✅ Server started successfully');
    return true;
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    return false;
  }
}

function stopServer() {
  if (serverProcess) {
    console.log('🛑 Stopping server...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

// Test functions
async function testWorkerInitialization() {
  console.log('\n📋 Testing SDK Worker Initialization...');
  
  try {
    const result = await makeRequest('/sdk/workers/init', {
      method: 'POST'
    });
    
    if (result.success && result.results.initialized.length === 4) {
      console.log('✅ Worker initialization: PASSED');
      console.log(`   - Initialized: ${result.results.initialized.length} workers`);
      console.log(`   - Failed: ${result.results.failed.length} workers`);
      return true;
    } else {
      console.log('❌ Worker initialization: FAILED');
      console.log('   Response:', result);
      return false;
    }
  } catch (error) {
    console.log('❌ Worker initialization: ERROR');
    console.log('   Error:', error.message);
    return false;
  }
}

async function testRouteRegistration() {
  console.log('\n📋 Testing SDK Route Registration...');
  
  try {
    const result = await makeRequest('/sdk/routes/register', {
      method: 'POST'
    });
    
    if (result.success && result.routes.length === 3) {
      console.log('✅ Route registration: PASSED');
      console.log(`   - Routes registered: ${result.routes.length}`);
      result.routes.forEach(route => {
        console.log(`   - ${route.route}: ${route.success ? 'SUCCESS' : 'FAILED'}`);
      });
      return true;
    } else {
      console.log('❌ Route registration: FAILED');
      console.log('   Response:', result);
      return false;
    }
  } catch (error) {
    console.log('❌ Route registration: ERROR');
    console.log('   Error:', error.message);
    return false;
  }
}

async function testSchedulerActivation() {
  console.log('\n📋 Testing SDK Scheduler Activation...');
  
  try {
    const result = await makeRequest('/sdk/scheduler/activate', {
      method: 'POST'
    });
    
    if (result.success && result.jobs.length === 3) {
      console.log('✅ Scheduler activation: PASSED');
      console.log(`   - Scheduled jobs: ${result.jobs.length}`);
      result.jobs.forEach(job => {
        console.log(`   - ${job.name} (${job.schedule}) → ${job.route}`);
      });
      console.log(`   - Missed job recovery: ${result.missedJobRecovery}`);
      return true;
    } else {
      console.log('❌ Scheduler activation: FAILED');
      console.log('   Response:', result);
      return false;
    }
  } catch (error) {
    console.log('❌ Scheduler activation: ERROR');
    console.log('   Error:', error.message);
    return false;
  }
}

async function testDiagnostics() {
  console.log('\n📋 Testing SDK Diagnostics...');
  
  try {
    // Test JSON format
    const jsonResult = await makeRequest('/sdk/diagnostics');
    
    if (jsonResult.success && jsonResult.diagnostics) {
      console.log('✅ Diagnostics (JSON): PASSED');
      console.log(`   - Workers count: ${jsonResult.diagnostics.workers.count}`);
      console.log(`   - Workers healthy: ${jsonResult.diagnostics.workers.healthy}`);
      console.log(`   - Error rate: ${jsonResult.diagnostics.error_rate}`);
      console.log(`   - Database connected: ${jsonResult.diagnostics.database.connected}`);
    } else {
      console.log('❌ Diagnostics (JSON): FAILED');
      return false;
    }
    
    // Test YAML format
    const yamlResult = await makeRequest('/sdk/diagnostics?format=yaml');
    
    if (typeof yamlResult === 'string' && yamlResult.includes('workers:')) {
      console.log('✅ Diagnostics (YAML): PASSED');
      console.log('   - YAML format verified');
      return true;
    } else {
      console.log('❌ Diagnostics (YAML): FAILED');
      return false;
    }
  } catch (error) {
    console.log('❌ Diagnostics: ERROR');
    console.log('   Error:', error.message);
    return false;
  }
}

async function testJobDispatch() {
  console.log('\n📋 Testing SDK Job Dispatch...');
  
  try {
    const result = await makeRequest('/sdk/jobs/dispatch', {
      method: 'POST',
      body: {
        workerId: 'worker-1',
        jobType: 'test-task',
        jobData: { message: 'Test from SDK suite' }
      }
    });
    
    if (result.success && result.result.workerId === 'worker-1') {
      console.log('✅ Job dispatch: PASSED');
      console.log(`   - Worker: ${result.result.workerId}`);
      console.log(`   - Job type: ${result.result.jobType}`);
      console.log(`   - Success: ${result.result.success}`);
      return true;
    } else {
      console.log('❌ Job dispatch: FAILED');
      console.log('   Response:', result);
      return false;
    }
  } catch (error) {
    console.log('❌ Job dispatch: ERROR');
    console.log('   Error:', error.message);
    return false;
  }
}

async function testWorkerStatus() {
  console.log('\n📋 Testing SDK Worker Status...');
  
  try {
    const result = await makeRequest('/sdk/workers/status');
    
    if (result.success && result.status.count === 4) {
      console.log('✅ Worker status: PASSED');
      console.log(`   - Worker count: ${result.status.count}`);
      console.log(`   - Healthy workers: ${result.status.healthy}`);
      result.status.workers.forEach(worker => {
        console.log(`   - ${worker.id}: ${worker.status}`);
      });
      return true;
    } else {
      console.log('❌ Worker status: FAILED');
      console.log('   Response:', result);
      return false;
    }
  } catch (error) {
    console.log('❌ Worker status: ERROR');
    console.log('   Error:', error.message);
    return false;
  }
}

async function testFullInitialization() {
  console.log('\n📋 Testing SDK Full Initialization...');
  
  try {
    const result = await makeRequest('/sdk/init-all', {
      method: 'POST'
    });
    
    if (result.success && result.results) {
      console.log('✅ Full initialization: PASSED');
      console.log(`   - Workers initialized: ${result.results.workers.initialized?.length || 0}`);
      console.log(`   - Routes registered: ${result.results.routes.registered?.length || 0}`);
      console.log(`   - Scheduler activated: ${result.results.scheduler.activated}`);
      console.log(`   - Diagnostics available: ${!!result.results.diagnostics}`);
      return true;
    } else {
      console.log('❌ Full initialization: FAILED');
      console.log('   Response:', result);
      return false;
    }
  } catch (error) {
    console.log('❌ Full initialization: ERROR');
    console.log('   Error:', error.message);
    return false;
  }
}

// Main test runner
async function runSDKTests() {
  console.log('🧪 ARCANOS SDK Test Suite');
  console.log('========================');
  
  // Start server
  const serverStarted = await startServer();
  if (!serverStarted) {
    console.log('❌ Failed to start server - aborting tests');
    process.exit(1);
  }
  
  const tests = [
    testWorkerInitialization,
    testRouteRegistration,
    testSchedulerActivation,
    testDiagnostics,
    testJobDispatch,
    testWorkerStatus,
    testFullInitialization
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of tests) {
    try {
      const result = await test();
      if (result) {
        passed++;
      } else {
        failed++;
      }
    } catch (error) {
      console.log(`❌ Test error: ${error.message}`);
      failed++;
    }
  }
  
  // Stop server
  stopServer();
  
  // Summary
  console.log('\n🎯 Test Summary');
  console.log('===============');
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📊 Total: ${passed + failed}`);
  
  if (failed === 0) {
    console.log('\n🎉 All SDK tests passed!');
    console.log('\n📋 SDK Implementation Summary:');
    console.log('✅ Worker initialization with 4 workers');
    console.log('✅ Route registration (worker.queue, audit.cron, job.cleanup)');
    console.log('✅ Scheduler activation with 3 cron jobs');
    console.log('✅ System diagnostics in JSON and YAML format');
    console.log('✅ Job dispatch functionality');
    console.log('✅ Worker status monitoring');
    console.log('✅ Full initialization sequence');
    process.exit(0);
  } else {
    console.log('\n❌ Some tests failed - check implementation');
    process.exit(1);
  }
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT - cleaning up...');
  stopServer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM - cleaning up...');
  stopServer();
  process.exit(0);
});

// Run tests
runSDKTests().catch(error => {
  console.error('Fatal error:', error);
  stopServer();
  process.exit(1);
});