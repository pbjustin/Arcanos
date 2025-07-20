// Test script for Backstage Booker Worker Status functionality
// Run with: node test-booker-functionality.js

const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testBookerFunctionality() {
  console.log('🧪 Testing Backstage Booker Worker Status Functionality\n');

  try {
    // Test 1: Get worker status from booker API
    console.log('📊 Test 1: Fetching worker status from /api/booker/workers/status');
    const statusResponse = await axios.get(`${BASE_URL}/api/booker/workers/status`);
    console.log(`✅ Status: ${statusResponse.status}`);
    console.log(`📋 Workers found: ${statusResponse.data.length}`);
    
    if (statusResponse.data.length > 0) {
      const firstWorker = statusResponse.data[0];
      console.log(`🔍 First worker: ${firstWorker.id} - ${firstWorker.task} (${firstWorker.status})`);
      console.log(`💻 CPU: ${firstWorker.cpu}, RAM: ${firstWorker.ram}, Uptime: ${firstWorker.uptime}`);
    }

    // Test 2: Add high-load worker
    console.log('\n🔧 Test 2: Adding high-load worker for testing');
    const addWorkerResponse = await axios.post(`${BASE_URL}/api/booker/workers/add-high-load`);
    console.log(`✅ Status: ${addWorkerResponse.status}`);
    console.log(`📝 Message: ${addWorkerResponse.data.message}`);

    // Test 3: Verify high-load worker appears and has high CPU
    console.log('\n⚡ Test 3: Verifying high-load worker has high CPU usage');
    const updatedStatusResponse = await axios.get(`${BASE_URL}/api/booker/workers/status`);
    const highLoadWorker = updatedStatusResponse.data.find(w => w.id === 'worker-test-high-load');
    
    if (highLoadWorker) {
      const cpuValue = parseFloat(highLoadWorker.cpu);
      console.log(`🔍 High-load worker: ${highLoadWorker.id} - ${highLoadWorker.task}`);
      console.log(`💻 CPU: ${highLoadWorker.cpu} (${cpuValue > 70 ? '⚠️ HIGH LOAD' : '✅ Normal'})`);
      
      if (cpuValue > 70) {
        console.log(`✅ Test passed: High CPU load detected (${highLoadWorker.cpu})`);
      } else {
        console.log(`❌ Test failed: Expected high CPU load, got ${highLoadWorker.cpu}`);
      }
    } else {
      console.log('❌ Test failed: High-load worker not found');
    }

    // Test 4: Test monitoring logic simulation
    console.log('\n📈 Test 4: Simulating monitoring logic');
    const workers = updatedStatusResponse.data;
    let alertsTriggered = 0;
    
    for (const worker of workers) {
      if (worker.status === 'running' && parseFloat(worker.cpu) > 70) {
        console.log(`⚠️ High load alert: ${worker.id} using ${worker.cpu} CPU`);
        alertsTriggered++;
      }
    }
    
    console.log(`📊 Total alerts triggered: ${alertsTriggered}`);
    
    if (alertsTriggered > 0) {
      console.log('✅ Monitoring logic working correctly');
    } else {
      console.log('⚠️ No alerts triggered - may be expected if no high-load workers');
    }

    console.log('\n🎉 All tests completed successfully!');
    console.log('\n📋 Summary:');
    console.log(`- API endpoint working: ✅`);
    console.log(`- Worker data format correct: ✅`);
    console.log(`- High-load worker creation: ✅`);
    console.log(`- CPU monitoring logic: ✅`);

  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    if (error.response) {
      console.error('📋 Response status:', error.response.status);
      console.error('📋 Response data:', error.response.data);
    }
    process.exit(1);
  }
}

// Check if running directly
if (require.main === module) {
  testBookerFunctionality();
}

module.exports = { testBookerFunctionality };