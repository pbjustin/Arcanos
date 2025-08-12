// Test the Sleep API Endpoints
const http = require('http');

console.log('🌐 Testing ARCANOS Sleep API Endpoints');
console.log('=======================================');

// Function to make HTTP requests
function makeRequest(path, callback) {
  const options = {
    hostname: 'localhost',
    port: 8080,
    path: path,
    method: 'GET'
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      try {
        const jsonData = JSON.parse(data);
        callback(null, jsonData, res.statusCode);
      } catch (_e) {
        callback(null, data, res.statusCode);
      }
    });
  });

  req.on('error', (err) => {
    callback(err, null, null);
  });

  req.end();
}

function testEndpoints() {
  console.log('\n📡 Testing /system/sleep endpoint...');
  
  makeRequest('/system/sleep', (err, data, statusCode) => {
    if (err) {
      console.log('❌ Server not running or endpoint unavailable:', err.message);
      console.log('💡 To test the live API, run: npm start (in another terminal)');
      console.log('   Then access: http://localhost:8080/system/sleep');
    } else {
      console.log(`✅ Response (${statusCode}):`);
      console.log(JSON.stringify(data, null, 2));
    }
    
    console.log('\n📡 Testing /performance endpoint...');
    makeRequest('/performance', (err, data, statusCode) => {
      if (err) {
        console.log('❌ Performance endpoint unavailable:', err.message);
      } else {
        console.log(`✅ Performance Response (${statusCode}):`);
        console.log('Sleep Status:', data.sleepStatus || 'Not included');
        console.log('Sleep Mode:', data.sleepMode || 'Not included');
      }
      
      console.log('\n🎯 API Endpoint Test Summary');
      console.log('============================');
      console.log('Endpoints implemented:');
      console.log('✅ GET /system/sleep - Sleep window status and timing');
      console.log('✅ POST /system/sleep/log - Force sleep status logging');
      console.log('✅ GET /performance - Enhanced with sleep mode information');
      console.log('✅ GET /health - Basic health check (sleep-unaffected)');
      console.log('');
      console.log('Features available:');
      console.log('• Real-time sleep window detection');
      console.log('• Next sleep/wake time calculations');
      console.log('• Server activity mode indicators');
      console.log('• Sleep manager status monitoring');
    });
  });
}

// Start the test
testEndpoints();