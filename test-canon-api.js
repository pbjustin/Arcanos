// Test script for Canon Folder Access API
// Run with: node test-canon-api.js

const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testCanonAPI() {
  console.log('📚 Testing Canon Folder Access API\n');

  try {
    // Test 1: List canon files
    console.log('📂 Test 1: Listing canon files');
    const listResponse = await axios.get(`${BASE_URL}/api/canon/files`);
    console.log(`✅ Status: ${listResponse.status}`);
    console.log(`📋 Files found: ${listResponse.data.length}`);
    console.log(`📂 Files: ${listResponse.data.join(', ')}`);

    // Test 2: Read an existing file
    if (listResponse.data.length > 0) {
      const fileName = listResponse.data[0];
      console.log(`\n📖 Test 2: Reading file "${fileName}"`);
      const readResponse = await axios.get(`${BASE_URL}/api/canon/files/${fileName}`);
      console.log(`✅ Status: ${readResponse.status}`);
      console.log(`📄 File name: ${readResponse.data.name}`);
      console.log(`📝 Content length: ${readResponse.data.content.length} characters`);
      console.log(`📝 First 100 chars: ${readResponse.data.content.substring(0, 100)}...`);
    }

    // Test 3: Write a new file
    console.log('\n💾 Test 3: Writing a new canon file');
    const newContent = `Test canon file created at ${new Date().toISOString()}\n\nThis file demonstrates:\n- File writing capability\n- Multi-line content\n- Timestamp tracking`;
    const writeResponse = await axios.post(`${BASE_URL}/api/canon/files/test-api-created.txt`, {
      content: newContent
    });
    console.log(`✅ Status: ${writeResponse.status}`);
    console.log(`💾 Message: ${writeResponse.data.message}`);

    // Test 4: Verify the written file can be read back
    console.log('\n🔄 Test 4: Verifying written file can be read back');
    const verifyResponse = await axios.get(`${BASE_URL}/api/canon/files/test-api-created.txt`);
    console.log(`✅ Status: ${verifyResponse.status}`);
    console.log(`📄 File name: ${verifyResponse.data.name}`);
    console.log(`📝 Content matches: ${verifyResponse.data.content === newContent ? '✅ Yes' : '❌ No'}`);

    // Test 5: Error handling - nonexistent file
    console.log('\n❌ Test 5: Error handling - nonexistent file');
    try {
      await axios.get(`${BASE_URL}/api/canon/files/nonexistent-file.txt`);
      console.log('❌ Expected error but got success');
    } catch (error) {
      console.log(`✅ Status: ${error.response.status}`);
      console.log(`✅ Error: ${error.response.data.error}`);
    }

    // Test 6: Security validation - directory traversal
    console.log('\n🔒 Test 6: Security validation - directory traversal');
    try {
      await axios.get(`${BASE_URL}/api/canon/files/..%2F..%2Fetc%2Fpasswd`);
      console.log('❌ Expected security error but got success');
    } catch (error) {
      console.log(`✅ Status: ${error.response.status}`);
      console.log(`✅ Security error: ${error.response.data.error}`);
    }

    // Test 7: Write validation - missing content
    console.log('\n📝 Test 7: Write validation - missing content');
    try {
      await axios.post(`${BASE_URL}/api/canon/files/test-no-content.txt`, {});
      console.log('❌ Expected validation error but got success');
    } catch (error) {
      console.log(`✅ Status: ${error.response.status}`);
      console.log(`✅ Validation error: ${error.response.data.error}`);
    }

    // Test 8: Final file list to show all operations
    console.log('\n📂 Test 8: Final file list');
    const finalListResponse = await axios.get(`${BASE_URL}/api/canon/files`);
    console.log(`✅ Status: ${finalListResponse.status}`);
    console.log(`📋 Total files: ${finalListResponse.data.length}`);
    console.log(`📂 Files: ${finalListResponse.data.join(', ')}`);

    console.log('\n🎉 All Canon API tests completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the tests if this script is executed directly
if (require.main === module) {
  testCanonAPI();
}

module.exports = { testCanonAPI };