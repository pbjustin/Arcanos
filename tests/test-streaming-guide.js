#!/usr/bin/env node

// Test script for the streaming guide functionality
// This script tests the new /api/guide streaming endpoint

const http = require('http');
const axios = require('axios');

// Test the streaming guide endpoint using raw HTTP for proper streaming
async function testStreamingGuideHTTP(port = 3000) {
  console.log('📡 Testing Streaming Guide endpoint with raw HTTP...\n');
  
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      prompt: "Create a comprehensive guide for playing chess effectively, including opening strategies, middle game tactics, and endgame principles."
    });

    const options = {
      hostname: 'localhost',
      port: port,
      path: '/api/guide',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    console.log('📤 Making streaming request...');
    console.log('URL:', `http://localhost:${port}/api/guide`);
    console.log('Prompt length:', postData.length);

    const req = http.request(options, (res) => {
      console.log(`📡 Response Status: ${res.statusCode}`);
      console.log('📡 Response Headers:');
      Object.keys(res.headers).forEach(key => {
        console.log(`  ${key}: ${res.headers[key]}`);
      });

      // Check if we got the expected streaming headers
      const isStreaming = res.headers['transfer-encoding'] === 'chunked' && 
                         res.headers['content-type'] && 
                         res.headers['content-type'].includes('text/plain');

      console.log('🔄 Streaming detected:', isStreaming ? '✅ YES' : '❌ NO');

      let fullResponse = '';
      let chunkCount = 0;
      let firstChunkTime = null;
      let lastChunkTime = null;
      const startTime = Date.now();

      res.on('data', (chunk) => {
        chunkCount++;
        const chunkStr = chunk.toString();
        const now = Date.now();
        
        if (!firstChunkTime) firstChunkTime = now;
        lastChunkTime = now;
        
        console.log(`📦 Chunk ${chunkCount} (${chunkStr.length} chars, +${now - startTime}ms):`, 
                   chunkStr.substring(0, 50).replace(/\n/g, '\\n') + 
                   (chunkStr.length > 50 ? '...' : ''));
        fullResponse += chunkStr;
      });

      res.on('end', () => {
        const totalTime = Date.now() - startTime;
        const streamTime = lastChunkTime - firstChunkTime;
        
        console.log('\n✅ Stream completed!');
        console.log(`📊 Statistics:`);
        console.log(`  Total chunks: ${chunkCount}`);
        console.log(`  Total length: ${fullResponse.length} characters`);
        console.log(`  Total time: ${totalTime}ms`);
        console.log(`  Stream time: ${streamTime}ms`);
        console.log(`  Time to first chunk: ${firstChunkTime - startTime}ms`);
        console.log(`  Average chunk size: ${Math.round(fullResponse.length / chunkCount)} chars`);
        
        console.log('\n📄 Response preview (first 300 chars):');
        console.log(fullResponse.substring(0, 300) + (fullResponse.length > 300 ? '...' : ''));
        
        resolve({ 
          statusCode: res.statusCode, 
          headers: res.headers, 
          body: fullResponse,
          chunkCount,
          totalTime,
          streamTime,
          isStreaming
        });
      });

      res.on('error', (err) => {
        console.error('❌ Response error:', err);
        reject(err);
      });
    });

    req.on('error', (err) => {
      console.error('❌ Request error:', err);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

// Test error handling with missing prompt
async function testStreamingGuideError(port = 3000) {
  console.log('\n🚨 Testing error handling...\n');
  
  try {
    const response = await axios.post(`http://localhost:${port}/api/guide`, {
      // Missing prompt field
    }, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log('❌ Error test failed: Should have returned an error');
    return false;
  } catch (error) {
    if (error.response && error.response.status === 400) {
      console.log('✅ Error handling works correctly:');
      console.log('Status:', error.response.status);
      console.log('Error message:', error.response.data.error);
      return true;
    } else {
      console.error('❌ Unexpected error:', error.response?.data || error.message);
      return false;
    }
  }
}

// Main test function
async function runStreamingTests() {
  console.log('🚀 Starting Streaming Guide Tests\n');
  
  let streamTest = false;
  let errorTest = false;
  
  try {
    const result = await testStreamingGuideHTTP();
    streamTest = result.statusCode === 200 && 
                result.isStreaming && 
                result.chunkCount > 1 && 
                result.body.length > 100;
    
    if (streamTest) {
      console.log('\n✅ Streaming test PASSED - endpoint is working correctly!');
    } else {
      console.log('\n❌ Streaming test FAILED - check the implementation');
    }
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      console.error('❌ Streaming test failed: Server not running');
      console.log('💡 To test the API, start the server first with: npm run dev');
    } else {
      console.error('❌ Streaming test failed:', error.message);
    }
  }
  
  try {
    errorTest = await testStreamingGuideError();
  } catch (error) {
    console.error('❌ Error test failed:', error.message);
  }
  
  console.log('\n📊 Test Results:');
  console.log('Streaming Functionality:', streamTest ? '✅ PASSED' : '❌ FAILED');
  console.log('Error Handling:', errorTest ? '✅ PASSED' : '❌ FAILED');
  
  if (streamTest && errorTest) {
    console.log('\n🎉 All tests passed! Streaming guide functionality is working correctly.');
    return true;
  } else if (streamTest) {
    console.log('\n⚠️ Streaming works but error handling failed.');
    return false;
  } else {
    console.log('\n❌ Tests failed. Check the implementation and make sure server is running.');
    return false;
  }
}

// Run tests if this script is executed directly
if (require.main === module) {
  runStreamingTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(console.error);
}

module.exports = { testStreamingGuideHTTP, testStreamingGuideError, runStreamingTests };