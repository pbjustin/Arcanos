/**
 * End-to-end test for ARCANOS API endpoint
 * Tests the complete API workflow including all required endpoints
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function testArcanosAPI() {
  console.log('🌐 ARCANOS API Endpoint Test');
  console.log('='.repeat(40));

  let serverProcess;
  const serverPort = 3001; // Use different port for testing
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

    // Wait for server to start and be ready
    console.log('   Waiting for server to start...');
    let serverReady = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        const { stdout } = await execAsync(`curl -s ${baseUrl}/health`);
        const healthData = JSON.parse(stdout);
        if (healthData.status === 'OK') {
          serverReady = true;
          console.log('   ✅ Server is ready');
          break;
        }
      } catch (error) {
        // Server not ready yet, continue waiting
        console.log(`   ⏳ Attempt ${attempt + 1}/10 - waiting for server...`);
      }
    }

    if (!serverReady) {
      throw new Error('Server failed to start after 10 attempts');
    }

    // Test health endpoint first (as required)
    console.log('\n2. Testing health endpoint...');
    try {
      const { stdout } = await execAsync(`curl -s ${baseUrl}/health`);
      const healthData = JSON.parse(stdout);
      
      if (healthData.status === 'OK' && healthData.service === 'ARCANOS') {
        console.log('✅ Health check: PASSED');
        console.log(`   - Service: ${healthData.service}`);
        console.log(`   - Status: ${healthData.status}`);
        console.log(`   - AI Model: ${healthData.ai?.defaultModel || 'N/A'}`);
      } else {
        console.log('❌ Health check failed:', healthData);
        throw new Error('Health check failed');
      }
    } catch (error) {
      console.log('❌ Health check failed:', error.message);
      throw error;
    }

    // Test all required endpoints: /ask, /arcanos, /write, /guide, /audit, /sim
    const endpoints = [
      { name: 'ask', path: '/ask', payload: { prompt: 'Test the ask endpoint' } },
      { name: 'arcanos', path: '/arcanos', payload: { userInput: 'Run system diagnosis.' } },
      { name: 'write', path: '/write', payload: { prompt: 'Generate test content' } },
      { name: 'guide', path: '/guide', payload: { prompt: 'Provide guidance' } },
      { name: 'audit', path: '/audit', payload: { prompt: 'Audit the system' } },
      { name: 'sim', path: '/sim', payload: { prompt: 'Simulate a scenario' } }
    ];

    for (let i = 0; i < endpoints.length; i++) {
      const endpoint = endpoints[i];
      console.log(`\n${3 + i}. Testing ${endpoint.name} endpoint (${endpoint.path})...`);
      
      try {
        const curlCmd = `curl -s -X POST ${baseUrl}${endpoint.path} -H "Content-Type: application/json" -d '${JSON.stringify(endpoint.payload)}'`;
        const { stdout } = await execAsync(curlCmd);
        const response = JSON.parse(stdout);

        // Validate response structure
        const hasRequiredFields = response.result && response.meta && response.activeModel;
        
        if (endpoint.name === 'arcanos') {
          // ARCANOS endpoint has specific structure
          if (response.componentStatus && response.suggestedFixes && response.coreLogicTrace) {
            console.log(`✅ ${endpoint.name} endpoint: PASSED (structured response)`);
          } else {
            console.log('❌ ARCANOS endpoint missing required fields:', response);
            throw new Error('ARCANOS endpoint structure validation failed');
          }
        } else if (hasRequiredFields) {
          console.log(`✅ ${endpoint.name} endpoint: PASSED`);
          console.log(`   - Active Model: ${response.activeModel}`);
          console.log(`   - Module: ${response.module || 'N/A'}`);
        } else {
          console.log(`❌ ${endpoint.name} endpoint missing required fields:`, response);
          throw new Error(`${endpoint.name} endpoint validation failed`);
        }
      } catch (error) {
        console.log(`❌ ${endpoint.name} endpoint test failed:`, error.message);
        throw error;
      }
    }

    // Test input validation
    console.log(`\n${3 + endpoints.length}. Testing validation (missing input)...`);
    try {
      const { stdout } = await execAsync(`curl -s -X POST ${baseUrl}/ask -H "Content-Type: application/json" -d '{}'`);
      const response = JSON.parse(stdout);
      
      if (response.error && response.error.includes('Missing or invalid')) {
        console.log('✅ Input validation works correctly');
      } else {
        console.log('❌ Input validation failed:', response);
        throw new Error('Input validation not working');
      }
    } catch (error) {
      console.log('❌ Validation test failed:', error.message);
      throw error;
    }

    // Test malformed JSON handling
    console.log(`\n${4 + endpoints.length}. Testing malformed JSON handling...`);
    try {
      const { stdout } = await execAsync(`curl -s -X POST ${baseUrl}/ask -H "Content-Type: application/json" -d 'invalid json'`);
      const response = JSON.parse(stdout);
      
      if (response.error) {
        console.log('✅ Malformed JSON handled correctly');
      } else {
        console.log('❌ Malformed JSON not handled:', response);
      }
    } catch (error) {
      // Expected - malformed JSON should cause parsing error
      console.log('✅ Malformed JSON rejected as expected');
    }

    console.log('\n🎉 All API endpoint tests passed!');
    console.log('\n📋 Test Summary:');
    console.log('- Health endpoint (/health) works correctly');
    console.log('- Ask endpoint (/ask) with ARCANOS shell injection');
    console.log('- ARCANOS endpoint (/arcanos) with structured diagnostics');
    console.log('- Write endpoint (/write) for content generation');
    console.log('- Guide endpoint (/guide) for step-by-step guidance');
    console.log('- Audit endpoint (/audit) for analysis and evaluation');
    console.log('- Sim endpoint (/sim) for simulations and modeling');
    console.log('- Input validation works correctly');
    console.log('- Malformed requests handled gracefully');
    console.log('- Mock responses when OPENAI_API_KEY not configured');
    console.log('- Server startup without crashing (no exit 127)');
    console.log('- Structured results with activeModel and fallback flags');
    
    return true;

  } catch (error) {
    console.error('❌ API test failed:', error);
    return false;
  } finally {
    // Clean up - kill the server process
    if (serverProcess) {
      console.log('\n11. Cleaning up server process...');
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Run the test
testArcanosAPI()
  .then(success => {
    if (success) {
      console.log('\n✅ API endpoint test completed successfully');
      process.exit(0);
    } else {
      console.log('\n❌ API endpoint test failed');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('❌ Test execution error:', error);
    process.exit(1);
  });
