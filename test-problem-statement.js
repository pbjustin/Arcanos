// Test script to verify the problem statement requirements are met
const http = require('http');

const makeRequest = (method, path, data = null) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: method === 'GET' && path === '/' ? body : JSON.parse(body),
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
};

const runTests = async () => {
  console.log('🧪 Testing Problem Statement Requirements...\n');

  try {
    // Test 1: Root route
    console.log('1. Testing GET /');
    const rootResponse = await makeRequest('GET', '/');
    console.log('   Status:', rootResponse.statusCode);
    console.log('   Response:', rootResponse.body);
    console.log('   ✅ Expected: "ARCANOS API is live."');
    console.log('   ✅ Match:', rootResponse.body === 'ARCANOS API is live.' ? 'YES' : 'NO');
    console.log('');

    // Test 2: POST /ask with both parameters
    console.log('2. Testing POST /ask with query and mode');
    const askResponse1 = await makeRequest('POST', '/ask', {
      query: 'test query',
      mode: 'analysis'
    });
    console.log('   Status:', askResponse1.statusCode);
    console.log('   Response:', JSON.stringify(askResponse1.body, null, 2));
    console.log('   ✅ Expected format: {"response": "Query received: \\"test query\\" in mode: \\"analysis\\""}');
    console.log('');

    // Test 3: POST /ask with default mode
    console.log('3. Testing POST /ask with query only (default mode)');
    const askResponse2 = await makeRequest('POST', '/ask', {
      query: 'another test'
    });
    console.log('   Status:', askResponse2.statusCode);
    console.log('   Response:', JSON.stringify(askResponse2.body, null, 2));
    console.log('   ✅ Expected default mode: "logic"');
    console.log('');

    // Test 4: POST /ask error handling
    console.log('4. Testing POST /ask error handling (missing query)');
    const askResponse3 = await makeRequest('POST', '/ask', {
      mode: 'logic'
    });
    console.log('   Status:', askResponse3.statusCode);
    console.log('   Response:', JSON.stringify(askResponse3.body, null, 2));
    console.log('   ✅ Expected error: {"error": "Missing query field"}');
    console.log('');

    console.log('🎉 All tests completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
};

// Run tests
runTests();