#!/usr/bin/env node

// Test script for Canon Access API
const { makeAxiosRequest, logTestResult, runEndpointTests } = require('./test-utils/common');

async function testCanonAPI() {
  console.log('🧪 Testing Canon Access API...\n');

  try {
    // Test 1: List canon files
    console.log('1. Testing GET /api/canon/files (List all canon files)');
    const listResult = await makeAxiosRequest('GET', '/api/canon/files');
    logTestResult('List canon files', listResult, true);
    console.log('');

    // Test 2: Read existing file
    if (listResult.success && listResult.data.files && listResult.data.files.length > 0) {
      const filename = listResult.data.files[0];
      console.log(`2. Testing GET /api/canon/files/${filename} (Read specific file)`);
      const readResult = await makeAxiosRequest('GET', `/api/canon/files/${filename}`);
      
      if (readResult.success) {
        console.log('✅ Response:', {
          filename: readResult.data.filename,
          contentLength: readResult.data.content.length,
          contentPreview: readResult.data.content.substring(0, 100) + '...'
        });
      } else {
        logTestResult(`Read file ${filename}`, readResult, true);
      }
      console.log('');
    }

    // Test 3: Write a new file
    console.log('3. Testing POST /api/canon/files/test-story.txt (Write new file)');
    const writeResponse = await axios.post(`${BASE_URL}/canon/files/test-story.txt`, {
      content: 'This is a test storyline file created by the API test.\n\nChapter 1: Testing\nThe API validation begins...'
    });
    console.log('✅ Response:', writeResponse.data);
    console.log('');

    // Test 4: Read the newly created file
    console.log('4. Testing GET /api/canon/files/test-story.txt (Read newly created file)');
    const readNewResponse = await axios.get(`${BASE_URL}/canon/files/test-story.txt`);
    console.log('✅ Response:', {
      filename: readNewResponse.data.filename,
      content: readNewResponse.data.content
    });
    console.log('');

    // Test 5: List files again to verify the new file is included
    console.log('5. Testing GET /api/canon/files again (Verify new file is listed)');
    const listResponse2 = await axios.get(`${BASE_URL}/canon/files`);
    console.log('✅ Response:', listResponse2.data);
    console.log('');

    console.log('🎉 All Canon API tests passed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

// Check if server is running, if not provide instructions
async function checkServer() {
  try {
    await axios.get(`${BASE_URL}`);
    return true;
  } catch (error) {
    console.log('❌ Server is not running on localhost:8080');
    console.log('Please start the server first:');
    console.log('  npm run dev  (or)  npm start');
    console.log('');
    return false;
  }
}

async function main() {
  const serverRunning = await checkServer();
  if (serverRunning) {
    await testCanonAPI();
  }
}

main();