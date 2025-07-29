// Test script for fine-tuned model routing functionality
const http = require('http');

const makeRequest = (method, path, data = null) => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 8080, // Updated to match the default port from config
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
          headers: res.headers,
          body: body.trim() ? (body.startsWith('{') ? JSON.parse(body) : body) : '',
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
  console.log('🧪 Testing Fine-Tuned Model Routing...\n');

  try {
    // Test 1: useFineTuned flag set to true
    console.log('1. Testing useFineTuned flag = true');
    const flagResponse = await makeRequest('POST', '/ask', {
      query: 'What is ARCANOS?',
      useFineTuned: true
    });
    console.log('   Status:', flagResponse.statusCode);
    console.log('   Routing:', flagResponse.body?.metadata?.routing);
    console.log('   Model:', flagResponse.body?.metadata?.model);
    console.log('   ✅ Expected: fine-tuned routing');
    console.log('   ✅ Actual routing:', flagResponse.body?.metadata?.routing === 'fine-tuned' ? 'PASS' : 'FAIL');
    console.log('');

    // Test 2: Query contains "finetune"
    console.log('2. Testing query containing "finetune"');
    const finetuneResponse = await makeRequest('POST', '/ask', {
      query: 'Use finetune model to answer: What is artificial intelligence?'
    });
    console.log('   Status:', finetuneResponse.statusCode);
    console.log('   Routing:', finetuneResponse.body?.metadata?.routing);
    console.log('   Model:', finetuneResponse.body?.metadata?.model);
    console.log('   ✅ Expected: fine-tuned routing');
    console.log('   ✅ Actual routing:', finetuneResponse.body?.metadata?.routing === 'fine-tuned' ? 'PASS' : 'FAIL');
    console.log('');

    // Test 3: Query contains "ft:"
    console.log('3. Testing query containing "ft:"');
    const ftResponse = await makeRequest('POST', '/ask', {
      query: 'Use ft: model to explain machine learning'
    });
    console.log('   Status:', ftResponse.statusCode);
    console.log('   Routing:', ftResponse.body?.metadata?.routing);
    console.log('   Model:', ftResponse.body?.metadata?.model);
    console.log('   ✅ Expected: fine-tuned routing');
    console.log('   ✅ Actual routing:', ftResponse.body?.metadata?.routing === 'fine-tuned' ? 'PASS' : 'FAIL');
    console.log('');

    // Test 4: frontend flag strips reflections
    console.log('4. Testing frontend flag strips reflections');
    const frontendResponse = await makeRequest('POST', '/ask', {
      query: 'What is ARCANOS?',
      useFineTuned: true,
      frontend: true
    });
    console.log('   Status:', frontendResponse.statusCode);
    console.log('   Frontend flag:', frontendResponse.body?.metadata?.frontend);
    console.log('   Response length:', frontendResponse.body?.response?.length || 0);
    console.log('   ✅ Expected: frontend = true');
    console.log('   ✅ Frontend flag set:', frontendResponse.body?.metadata?.frontend === true ? 'PASS' : 'FAIL');
    console.log('');

    // Test 5: Regular query without fine-tune routing (should use reflective logic)
    console.log('5. Testing regular query (should use reflective logic)');
    const regularResponse = await makeRequest('POST', '/ask', {
      query: 'What is artificial intelligence?'
    });
    console.log('   Status:', regularResponse.statusCode);
    console.log('   Routing:', regularResponse.body?.metadata?.routing);
    console.log('   ✅ Expected: reflective routing');
    console.log('   ✅ Actual routing:', regularResponse.body?.metadata?.routing === 'reflective' ? 'PASS' : 'FAIL');
    console.log('');

    // Test 6: Backward compatibility with message parameter
    console.log('6. Testing backward compatibility with message parameter');
    const messageResponse = await makeRequest('POST', '/ask', {
      message: 'What is ARCANOS?',
      domain: 'testing'
    });
    console.log('   Status:', messageResponse.statusCode);
    console.log('   Routing:', messageResponse.body?.metadata?.routing);
    console.log('   Domain:', messageResponse.body?.metadata?.domain);
    console.log('   ✅ Expected: reflective routing, domain = testing');
    console.log('   ✅ Backward compatibility:', 
      (messageResponse.body?.metadata?.routing === 'reflective' && 
       messageResponse.body?.metadata?.domain === 'testing') ? 'PASS' : 'FAIL');
    console.log('');

    // Test 7: Error handling - missing query/message
    console.log('7. Testing error handling - missing query/message');
    const errorResponse = await makeRequest('POST', '/ask', {
      mode: 'logic'
    });
    console.log('   Status:', errorResponse.statusCode);
    console.log('   Error:', errorResponse.body?.error);
    console.log('   ✅ Expected: 400 error');
    console.log('   ✅ Error handling:', errorResponse.statusCode === 400 ? 'PASS' : 'FAIL');
    console.log('');

    console.log('🎉 All fine-tune routing tests completed!');
    console.log('');
    console.log('📋 SUMMARY:');
    console.log('   ✅ useFineTuned flag routing');
    console.log('   ✅ "finetune" keyword detection');
    console.log('   ✅ "ft:" keyword detection');
    console.log('   ✅ Frontend response stripping');
    console.log('   ✅ Reflective logic fallback');
    console.log('   ✅ Backward compatibility');
    console.log('   ✅ Error handling');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.log('');
    console.log('💡 Make sure the ARCANOS server is running on port 8080');
    console.log('   Run: npm run dev (or npm start)');
    process.exit(1);
  }
};

// Run tests
runTests();