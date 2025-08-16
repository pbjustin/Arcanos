/**
 * Test for health check functionality using /health endpoint
 * Tests the dedicated health endpoint instead of ping/pong in AI endpoints
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function testHealthEndpoint() {
  console.log('🏥 ARCANOS Health Endpoint Test');
  console.log('='.repeat(45));

  let serverProcess;
  const serverPort = 3002; // Use different port for testing
  const baseUrl = `http://localhost:${serverPort}`;

  try {
    console.log('1. Starting local ARCANOS server...');
    
    // Start the server process for testing
    serverProcess = spawn('node', ['dist/server.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: serverPort.toString(),
        NODE_ENV: 'test',
        OPENAI_API_KEY: '' // Test with empty API key for mock responses
      }
    });

    // Wait for server to start
    console.log('   Waiting for server to start...');
    let serverReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const { stdout } = await execAsync(`curl -s ${baseUrl}/health`);
        const healthData = JSON.parse(stdout);
        if (healthData.status === 'OK') {
          serverReady = true;
          console.log('   ✅ Server is ready');
          break;
        }
      } catch (error) {
        console.log(`   ⏳ Attempt ${attempt + 1}/10 - waiting for server...`);
      }
    }

    if (!serverReady) {
      throw new Error('Server failed to start after 10 attempts');
    }

    // Test 1: Health endpoint functionality
    console.log('\n2. Testing health endpoint...');
    const { stdout: healthResponse } = await execAsync(`curl -s ${baseUrl}/health`);
    const healthData = JSON.parse(healthResponse);
    
    if (healthData.status === 'OK' && healthData.service === 'ARCANOS') {
      console.log('✅ Health endpoint test: PASSED');
      console.log(`   Response: ${JSON.stringify(healthData)}`);
    } else {
      throw new Error(`Health endpoint test failed: ${JSON.stringify(healthData)}`);
    }

    // Test 2: Status endpoint functionality  
    console.log('\n3. Testing status endpoint...');
    const { stdout: statusResponse } = await execAsync(`curl -s ${baseUrl}/status`);
    const statusData = JSON.parse(statusResponse);
    
    if (statusData.status && statusData.version) {
      console.log('✅ Status endpoint test: PASSED');
      console.log(`   Status: ${statusData.status}, Version: ${statusData.version}`);
    } else {
      throw new Error(`Status endpoint test failed: ${JSON.stringify(statusData)}`);
    }

    // Test 3: Test /ask endpoint for AI queries
    console.log('\n4. Testing ask endpoint for AI functionality...');
    const { stdout: askResponse } = await execAsync(`curl -s -X POST ${baseUrl}/ask -H "Content-Type: application/json" -d '{"prompt":"Hello World"}'`);
    const askData = JSON.parse(askResponse);
    
    if (askData.result && askData.activeModel) {
      console.log('✅ Ask endpoint test: PASSED');
      console.log(`   Active Model: ${askData.activeModel}`);
    } else {
      throw new Error(`Ask endpoint test failed: ${JSON.stringify(askData)}`);
    }

    // Test 4: Verify endpoint separation
    console.log('\n5. Testing endpoint separation...');
    // Health endpoint should be simple and fast
    const healthStart = Date.now();
    const { stdout: quickHealthResponse } = await execAsync(`curl -s ${baseUrl}/health`);
    const healthTime = Date.now() - healthStart;
    const quickHealthData = JSON.parse(quickHealthResponse);
    
    if (quickHealthData.status === 'OK' && healthTime < 1000) {
      console.log('✅ Health endpoint performance test: PASSED (fast response)');
      console.log(`   Response time: ${healthTime}ms`);
    } else {
      throw new Error('Health endpoint performance test failed: response too slow or invalid');
    }

    console.log('\n🎉 All health and endpoint tests passed!');
    console.log('\n📋 Test Summary:');
    console.log('- Health endpoint (/health) provides system health information');
    console.log('- Status endpoint (/status) provides backend status');
    console.log('- Ask endpoint (/ask) provides AI functionality');
    console.log('- Proper endpoint separation maintained');
    console.log('- Health checks are fast and efficient');
    
    return true;

  } catch (error) {
    console.error('❌ Health endpoint test failed:', error);
    return false;
  } finally {
    // Clean up - kill the server process
    if (serverProcess) {
      console.log('\n6. Cleaning up server process...');
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Run the test
testHealthEndpoint()
  .then(success => {
    if (success) {
      console.log('\n✅ Ping/pong healthcheck test completed successfully');
      process.exit(0);
    } else {
      console.log('\n❌ Ping/pong healthcheck test failed');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('❌ Test execution error:', error);
    process.exit(1);
  });