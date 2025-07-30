/**
 * Example usage of Web Fallback Service
 * Demonstrates how to use the web fallback functionality in ARCANOS
 */

import { webFallbackToGPT, getWebFallbackService } from '../src/services/web-fallback';

async function demonstrateWebFallback() {
  console.log('🔍 ARCANOS Web Fallback Demonstration\n');

  // Example 1: Basic usage with the main function from problem statement
  console.log('Example 1: Basic webFallbackToGPT usage');
  try {
    const basicResult = await webFallbackToGPT({
      url: 'https://example.com',
      topic: 'Web development example'
    });
    
    console.log('📄 Basic Result:');
    console.log(basicResult);
    console.log('\n' + '─'.repeat(50) + '\n');
  } catch (error: any) {
    console.log('❌ Basic example failed:', error.message);
  }

  // Example 2: Using the enhanced service for more control
  console.log('Example 2: Enhanced WebFallbackService usage');
  try {
    const service = getWebFallbackService();
    
    const enhancedResult = await service.fetchAndSummarize({
      url: 'https://httpbin.org/html',
      topic: 'HTTP testing and API validation',
      timeout: 20000,
      maxContentLength: 500000
    });
    
    if (enhancedResult.success) {
      console.log('📄 Enhanced Result:');
      console.log('Content:', enhancedResult.content);
      console.log('📊 Metadata:', enhancedResult.metadata);
    } else {
      console.log('❌ Enhanced example failed:', enhancedResult.error);
    }
    console.log('\n' + '─'.repeat(50) + '\n');
  } catch (error: any) {
    console.log('❌ Enhanced example failed:', error.message);
  }

  // Example 3: Batch processing multiple URLs
  console.log('Example 3: Batch processing');
  try {
    const service = getWebFallbackService();
    
    const batchRequests = [
      { url: 'https://example.com', topic: 'Example domain' },
      { url: 'https://httpbin.org/html', topic: 'HTTP testing' }
    ];
    
    const batchResults = await service.processBatch(batchRequests);
    
    console.log('📄 Batch Results:');
    batchResults.forEach((result, index) => {
      console.log(`Result ${index + 1}:`, {
        success: result.success,
        contentLength: result.content.length,
        url: result.metadata?.url
      });
    });
    console.log('\n' + '─'.repeat(50) + '\n');
  } catch (error: any) {
    console.log('❌ Batch example failed:', error.message);
  }

  // Example 4: URL validation before processing
  console.log('Example 4: URL validation');
  try {
    const service = getWebFallbackService();
    
    const urlsToValidate = [
      'https://example.com',
      'https://invalid-url-that-should-fail.nonexistent'
    ];
    
    for (const url of urlsToValidate) {
      const validation = await service.validateUrl(url);
      console.log(`URL: ${url}`);
      console.log(`Valid: ${validation.valid}`);
      if (!validation.valid) {
        console.log(`Error: ${validation.error}`);
      }
      console.log('');
    }
  } catch (error: any) {
    console.log('❌ Validation example failed:', error.message);
  }

  console.log('🏁 Web Fallback demonstration completed');
}

// Export for use in other modules
export { demonstrateWebFallback };

// Run demonstration if this file is executed directly
if (require.main === module) {
  demonstrateWebFallback().catch(console.error);
}