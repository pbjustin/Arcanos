/**
 * Test script for safeFetchHtml function
 * Validates HTML fetching with content-type validation and error handling
 */

import { safeFetchHtml } from '../src/utils/http.js';

async function runSafeFetchHtmlTests() {
  console.log('🧪 Running safeFetchHtml Tests\n');

  // Test 1: Valid HTML URL
  console.log('Test 1: Fetching valid HTML content');
  try {
    const result = await safeFetchHtml('https://example.com');
    
    if (result.error === null && result.raw !== null) {
      console.log('✅ Valid HTML test passed');
      console.log('HTML content length:', result.raw.length);
      console.log('Content preview:', result.raw.substring(0, 100) + '...\n');
    } else {
      console.log('❌ Valid HTML test failed:', result.error);
    }
  } catch (error: any) {
    console.log('❌ Valid HTML test failed with exception:', error.message);
  }

  // Test 2: Non-HTML content (should return error)
  console.log('Test 2: Fetching non-HTML content (JSON API)');
  try {
    const result = await safeFetchHtml('https://httpbin.org/json');
    
    if (result.error !== null && result.raw === null) {
      console.log('✅ Non-HTML content test passed');
      console.log('Expected error:', result.error, '\n');
    } else {
      console.log('❌ Non-HTML content test failed - should have returned error');
      console.log('Result:', result);
    }
  } catch (error: any) {
    console.log('❌ Non-HTML content test failed with exception:', error.message);
  }

  // Test 3: Invalid URL (should return error)
  console.log('Test 3: Fetching from invalid URL');
  try {
    const result = await safeFetchHtml('https://invalid-url-that-does-not-exist-12345.com');
    
    if (result.error !== null && result.raw === null) {
      console.log('✅ Invalid URL test passed');
      console.log('Expected error:', result.error, '\n');
    } else {
      console.log('❌ Invalid URL test failed - should have returned error');
      console.log('Result:', result);
    }
  } catch (error: any) {
    console.log('❌ Invalid URL test failed with exception:', error.message);
  }

  // Test 4: HTML with specific content-type
  console.log('Test 4: Fetching HTML content from httpbin');
  try {
    const result = await safeFetchHtml('https://httpbin.org/html');
    
    if (result.error === null && result.raw !== null) {
      console.log('✅ HTML content test passed');
      console.log('HTML content length:', result.raw.length);
      console.log('Contains HTML tags:', result.raw.includes('<html>'));
    } else {
      console.log('❌ HTML content test failed:', result.error);
    }
  } catch (error: any) {
    console.log('❌ HTML content test failed with exception:', error.message);
  }

  console.log('\n🏁 safeFetchHtml tests completed');
}

// Run tests if this file is executed directly
if (require.main === module) {
  runSafeFetchHtmlTests().catch(console.error);
}

export { runSafeFetchHtmlTests };
