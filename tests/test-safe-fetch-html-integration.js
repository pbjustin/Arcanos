/**
 * Integration example showing how safeFetchHtml can be used within the ARCANOS codebase
 */
import { safeFetchHtml } from '../src/utils/http';
/**
 * Example service function that uses safeFetchHtml for safe HTML content retrieval
 */
export async function processWebContent(url) {
    const result = await safeFetchHtml(url);
    if (result.error === null && result.raw !== null) {
        // Process the HTML content - for example, extract title
        const titleMatch = result.raw.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1] : 'No title found';
        return {
            status: 'success',
            content: `Successfully fetched HTML from ${url}. Title: "${title}". Content length: ${result.raw.length} characters.`
        };
    }
    else {
        return {
            status: 'error',
            content: `Failed to fetch HTML from ${url}: ${result.error}`
        };
    }
}
/**
 * Example batch processing using safeFetchHtml
 */
export async function batchProcessUrls(urls) {
    const results = await Promise.allSettled(urls.map(async (url) => {
        const result = await safeFetchHtml(url);
        return { url, result };
    }));
    return results.map((promiseResult, index) => {
        const url = urls[index];
        if (promiseResult.status === 'fulfilled') {
            const { result } = promiseResult.value;
            if (result.error === null) {
                return {
                    url,
                    success: true,
                    message: `Successfully fetched ${result.raw?.length} characters of HTML`
                };
            }
            else {
                return {
                    url,
                    success: false,
                    message: result.error
                };
            }
        }
        else {
            return {
                url,
                success: false,
                message: promiseResult.reason?.message || 'Unknown error'
            };
        }
    });
}
// Demo usage
async function runIntegrationDemo() {
    console.log('🔧 Integration Demo: Using safeFetchHtml in ARCANOS services\n');
    // Test single URL processing
    console.log('1️⃣ Testing single URL processing:');
    const singleResult = await processWebContent('https://example.com');
    console.log(`Status: ${singleResult.status}`);
    console.log(`Message: ${singleResult.content}\n`);
    // Test batch processing
    console.log('2️⃣ Testing batch URL processing:');
    const testUrls = [
        'https://example.com',
        'https://httpbin.org/html',
        'https://httpbin.org/json', // This should fail content-type validation
        'https://invalid-url.invalid' // This should fail with network error
    ];
    const batchResults = await batchProcessUrls(testUrls);
    batchResults.forEach((result, index) => {
        const status = result.success ? '✅' : '❌';
        console.log(`${status} ${result.url}: ${result.message}`);
    });
    console.log('\n🎯 Integration demo completed!');
}
// Run demo if this file is executed directly
if (require.main === module) {
    runIntegrationDemo().catch(console.error);
}
