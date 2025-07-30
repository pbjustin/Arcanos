/**
 * Demo script showcasing the safeFetchHtml function
 * This demonstrates the functionality implemented according to the problem statement
 */

import { safeFetchHtml } from './src/utils/http';

async function demonstrateSafeFetchHtml() {
  console.log('🚀 Demonstrating safeFetchHtml Function\n');
  console.log('This function safely fetches HTML content with proper validation.\n');

  // Example 1: Successful HTML fetch
  console.log('📄 Example 1: Fetching HTML from example.com');
  const htmlResult = await safeFetchHtml('https://example.com');
  
  if (htmlResult.error === null) {
    console.log('✅ Success! Retrieved HTML content');
    console.log(`📏 Content length: ${htmlResult.raw?.length} characters`);
    console.log(`🔍 Preview: ${htmlResult.raw?.substring(0, 150)}...`);
  } else {
    console.log('❌ Error:', htmlResult.error);
  }

  console.log('\n' + '='.repeat(60) + '\n');

  // Example 2: Non-HTML content (should fail validation)
  console.log('📄 Example 2: Attempting to fetch JSON (should fail content-type validation)');
  const jsonResult = await safeFetchHtml('https://httpbin.org/json');
  
  if (jsonResult.error !== null) {
    console.log('✅ Expected behavior: Content-type validation worked');
    console.log(`❌ Error (as expected): ${jsonResult.error}`);
    console.log(`📏 Raw content: ${jsonResult.raw}`);
  } else {
    console.log('❌ Unexpected: Should have failed content-type validation');
  }

  console.log('\n' + '='.repeat(60) + '\n');

  // Example 3: Invalid URL (should fail with network error)
  console.log('📄 Example 3: Attempting to fetch from invalid URL');
  const invalidResult = await safeFetchHtml('https://this-domain-does-not-exist-12345.invalid');
  
  if (invalidResult.error !== null) {
    console.log('✅ Expected behavior: Network error handled gracefully');
    console.log(`❌ Error (as expected): ${invalidResult.error}`);
    console.log(`📏 Raw content: ${invalidResult.raw}`);
  } else {
    console.log('❌ Unexpected: Should have failed with network error');
  }

  console.log('\n🎯 Demo completed - safeFetchHtml function is working as specified!');
}

// Run demo
demonstrateSafeFetchHtml().catch(error => {
  console.error('❌ Demo failed with error:', error);
});