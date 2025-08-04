/**
 * Test script for Web Fallback Service
 * Validates web content fetching and GPT summarization functionality
 */
import { webFallbackToGPT, getWebFallbackService } from '../src/services/web-fallback';
const testUrls = [
    {
        url: 'https://httpbin.org/html',
        topic: 'HTTP testing service'
    },
    {
        url: 'https://example.com',
        topic: 'Example domain'
    }
];
async function runBasicTests() {
    console.log('🧪 Running Web Fallback Service Tests\n');
    // Test 1: Basic webFallbackToGPT function
    console.log('Test 1: Basic webFallbackToGPT function');
    try {
        const result = await webFallbackToGPT({
            url: 'https://example.com',
            topic: 'Example website'
        });
        console.log('✅ Basic function test passed');
        console.log('Response:', result.substring(0, 200) + '...\n');
    }
    catch (error) {
        console.log('❌ Basic function test failed:', error.message);
    }
    // Test 2: Service class functionality
    console.log('Test 2: WebFallbackService class');
    try {
        const service = getWebFallbackService();
        const result = await service.fetchAndSummarize({
            url: 'https://httpbin.org/html',
            topic: 'HTTP test page',
            timeout: 15000
        });
        if (result.success) {
            console.log('✅ Service class test passed');
            console.log('Response length:', result.content.length);
            console.log('Metadata:', result.metadata);
        }
        else {
            console.log('❌ Service class test failed:', result.error);
        }
    }
    catch (error) {
        console.log('❌ Service class test failed:', error.message);
    }
    // Test 3: URL validation
    console.log('\nTest 3: URL validation');
    try {
        const service = getWebFallbackService();
        const validationResult = await service.validateUrl('https://example.com');
        console.log('URL validation result:', validationResult);
        if (validationResult.valid) {
            console.log('✅ URL validation test passed');
        }
        else {
            console.log('❌ URL validation test failed:', validationResult.error);
        }
    }
    catch (error) {
        console.log('❌ URL validation test failed:', error.message);
    }
    console.log('\n🏁 Web Fallback tests completed');
}
// Run tests if this file is executed directly
if (require.main === module) {
    runBasicTests().catch(console.error);
}
export { runBasicTests };
