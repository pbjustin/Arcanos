/**
 * Test for ping/pong healthcheck functionality in /api/arcanos/ask endpoint
 * Validates the new ping/pong feature without disrupting existing functionality
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function testPingPongHealthcheck() {
  console.log('🏓 ARCANOS Ping/Pong Healthcheck Test');
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

    // Test 1: Basic ping functionality
    console.log('\n2. Testing basic ping functionality...');
    const { stdout: pingResponse } = await execAsync(`curl -s -X POST ${baseUrl}/api/arcanos/ask -H "Content-Type: application/json" -d '{"prompt":"ping"}'`);
    const pingData = JSON.parse(pingResponse);
    
    if (pingData.success === true && pingData.result === 'pong') {
      console.log('✅ Basic ping test: PASSED');
      console.log(`   Response: ${JSON.stringify(pingData)}`);
    } else {
      throw new Error(`Basic ping test failed: ${JSON.stringify(pingData)}`);
    }

    // Test 2: Case insensitive ping
    console.log('\n3. Testing case insensitive ping...');
    const { stdout: upperPingResponse } = await execAsync(`curl -s -X POST ${baseUrl}/api/arcanos/ask -H "Content-Type: application/json" -d '{"prompt":"PING"}'`);
    const upperPingData = JSON.parse(upperPingResponse);
    
    if (upperPingData.success === true && upperPingData.result === 'pong') {
      console.log('✅ Case insensitive ping test: PASSED');
    } else {
      throw new Error(`Case insensitive ping test failed: ${JSON.stringify(upperPingData)}`);
    }

    // Test 3: Ping with whitespace
    console.log('\n4. Testing ping with whitespace...');
    const { stdout: whitespacePingResponse } = await execAsync(`curl -s -X POST ${baseUrl}/api/arcanos/ask -H "Content-Type: application/json" -d '{"prompt":"  ping  "}'`);
    const whitespacePingData = JSON.parse(whitespacePingResponse);
    
    if (whitespacePingData.success === true && whitespacePingData.result === 'pong') {
      console.log('✅ Whitespace ping test: PASSED');
    } else {
      throw new Error(`Whitespace ping test failed: ${JSON.stringify(whitespacePingData)}`);
    }

    // Test 4: Verify normal functionality still works
    console.log('\n5. Testing normal functionality preservation...');
    const { stdout: normalResponse } = await execAsync(`curl -s -X POST ${baseUrl}/api/arcanos/ask -H "Content-Type: application/json" -d '{"prompt":"Hello World"}'`);
    const normalData = JSON.parse(normalResponse);
    
    if (normalData.success === true && normalData.result && normalData.result.meta) {
      console.log('✅ Normal functionality test: PASSED');
      console.log(`   Active Model: ${normalData.result.activeModel}`);
    } else {
      throw new Error(`Normal functionality test failed: ${JSON.stringify(normalData)}`);
    }

    // Test 5: Verify ping doesn't bypass to AI processing
    console.log('\n6. Testing ping bypasses AI processing...');
    // The ping response should be immediate and simple, not the complex AI response
    if (typeof pingData.result === 'string' && pingData.result === 'pong') {
      console.log('✅ Ping bypass test: PASSED (simple string response, no AI processing)');
    } else {
      throw new Error('Ping bypass test failed: response appears to have gone through AI processing');
    }

    // Test 6: Verify near-ping prompts don't trigger ping response
    console.log('\n7. Testing non-ping prompts...');
    const { stdout: nonPingResponse } = await execAsync(`curl -s -X POST ${baseUrl}/api/arcanos/ask -H "Content-Type: application/json" -d '{"prompt":"pingpong"}'`);
    const nonPingData = JSON.parse(nonPingResponse);
    
    if (nonPingData.success === true && nonPingData.result !== 'pong' && nonPingData.result.meta) {
      console.log('✅ Non-ping prompt test: PASSED (goes through AI processing)');
    } else {
      throw new Error(`Non-ping prompt test failed: ${JSON.stringify(nonPingData)}`);
    }

    console.log('\n🎉 All ping/pong healthcheck tests passed!');
    console.log('\n📋 Test Summary:');
    console.log('- Basic ping → pong functionality works');
    console.log('- Case insensitive ping detection');
    console.log('- Whitespace tolerant ping detection');
    console.log('- Normal AI functionality preserved');
    console.log('- Ping bypasses AI processing for efficiency');
    console.log('- Non-ping prompts still go through AI processing');
    console.log('- Response format maintained');
    
    return true;

  } catch (error) {
    console.error('❌ Ping/pong test failed:', error);
    return false;
  } finally {
    // Clean up - kill the server process
    if (serverProcess) {
      console.log('\n8. Cleaning up server process...');
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Run the test
testPingPongHealthcheck()
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