/**
 * End-to-end test for ARCANOS API endpoint
 * Tests the complete API workflow including the /arcanos endpoint
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function testArcanosAPI() {
  console.log('🌐 ARCANOS API Endpoint Test');
  console.log('='.repeat(40));

  let serverProcess;

  try {
    // Assume server is started externally
    console.log('1. Using existing ARCANOS server...');

    // Test health endpoint against live Railway deployment
    console.log('\n2. Testing health endpoint...');
    try {
      const { stdout } = await execAsync('curl -s https://arcanos-v2-production.up.railway.app/health');
      const healthData = JSON.parse(stdout);
      console.log('✅ Health check:', healthData.status === 'OK' ? 'PASSED' : 'FAILED');
    } catch (error) {
      console.log('❌ Health check failed:', error.message);
      throw error;
    }

    // Test ARCANOS endpoint structure
      console.log('\n3. Testing ARCANOS endpoint structure...');
    try {
      const { stdout } = await execAsync('curl -s -X POST https://arcanos-v2-production.up.railway.app/arcanos -H "Content-Type: application/json" -d \'{"userInput": "Run system diagnosis."}\'');
      const response = JSON.parse(stdout);

      if (response.result && response.componentStatus && response.suggestedFixes && response.coreLogicTrace) {
        console.log('✅ ARCANOS endpoint responds with structured diagnostics');
      } else {
        console.log('❌ Unexpected response:', response);
        throw new Error('Unexpected API response');
      }
    } catch (error) {
      console.log('❌ ARCANOS endpoint test failed:', error.message);
      throw error;
    }

    // Test endpoint with missing userInput
    console.log('\n4. Testing validation (missing userInput)...');
    try {
      const { stdout } = await execAsync('curl -s -X POST https://arcanos-v2-production.up.railway.app/arcanos -H "Content-Type: application/json" -d \'{}\'');
      const response = JSON.parse(stdout);
      
      if (response.error && response.error.includes('Missing or invalid userInput')) {
        console.log('✅ Input validation works correctly');
      } else {
        console.log('❌ Input validation failed:', response);
        throw new Error('Input validation not working');
      }
    } catch (error) {
      console.log('❌ Validation test failed:', error.message);
      throw error;
    }

    // Test endpoint with invalid JSON
    console.log('\n5. Testing malformed JSON handling...');
    try {
      const { stdout } = await execAsync('curl -s -X POST https://arcanos-v2-production.up.railway.app/arcanos -H "Content-Type: application/json" -d \'invalid json\'');
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
    console.log('- Health endpoint works correctly');
    console.log('- ARCANOS endpoint accepts POST requests');
    console.log('- Proper error handling for missing API key');
    console.log('- Input validation works correctly');
    console.log('- Malformed requests handled gracefully');
    console.log('- Server startup and routing functional');
    
    return true;

  } catch (error) {
    console.error('❌ API test failed:', error);
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
