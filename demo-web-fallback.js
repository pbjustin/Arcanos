#!/usr/bin/env node

/**
 * CLI Demo Script for Web Fallback Service
 * Demonstrates the HTTP fetching and HTML extraction without requiring OpenAI API
 */

const axios = require('axios');

// Mock the extractSummaryFromHtml function from the service
function extractSummaryFromHtml(html, topicHint = "") {
  const plain = html.replace(/<[^>]+>/g, "").slice(0, 2000);
  return topicHint ? `[${topicHint}]\n${plain}` : plain;
}

async function demonstrateWebFallback() {
  console.log('🌐 ARCANOS Web Fallback CLI Demo\n');
  console.log('This demo shows the HTTP fetching and HTML extraction functionality');
  console.log('(GPT-4 summarization requires OpenAI API key in production)\n');

  const testUrl = 'https://httpbin.org/html';
  const topic = 'HTTP testing service';

  try {
    console.log(`📡 Fetching content from: ${testUrl}`);
    console.log(`📋 Topic: ${topic}\n`);

    // Simulate the exact HTTP request from the service
    const response = await axios.get(testUrl, {
      headers: { "User-Agent": "ARCANOS/1.0 (Web Intelligence Agent)" },
      timeout: 30000,
      maxContentLength: 1000000
    });

    console.log('✅ HTTP Request Successful!');
    console.log(`Status: ${response.status}`);
    console.log(`Content-Type: ${response.headers['content-type']}`);
    console.log(`Content Length: ${response.data.length} bytes\n`);

    // Extract summary from HTML (as done in the service)
    const summary = extractSummaryFromHtml(response.data, topic);

    console.log('📄 Extracted Summary:');
    console.log('─'.repeat(60));
    console.log(summary);
    console.log('─'.repeat(60));

    console.log('\n🤖 In production, this summary would be sent to GPT-4 with:');
    console.log('System: "You are a summarizer and strategic AI."');
    console.log('User: "Given this info from the web, provide a tactical summary:"');
    console.log('\n✨ Expected GPT-4 Response: A concise tactical analysis of the content');

  } catch (error) {
    console.log('❌ Demo failed:', error.message);
    console.log('\nThis would trigger the fallback response:');
    console.log('"⚠️ Could not retrieve or summarize external content."');
  }

  console.log('\n🏁 Demo completed!');
  console.log('\nTo test with real GPT-4 integration:');
  console.log('1. Set OPENAI_API_KEY environment variable');
  console.log('2. Run: npx ts-node examples/web-fallback-demo.ts');
  console.log('3. Or use the API endpoints: POST /api/web-fallback/summarize');
}

// URL validation demo
async function demonstrateUrlValidation() {
  console.log('\n🔍 URL Validation Demo\n');

  const testUrls = [
    'https://example.com',
    'https://httpbin.org/html',
    'https://invalid-domain-that-does-not-exist.fake'
  ];

  for (const url of testUrls) {
    try {
      console.log(`Testing: ${url}`);
      await axios.head(url, {
        headers: { "User-Agent": "ARCANOS/1.0 (Web Intelligence Agent)" },
        timeout: 5000
      });
      console.log('✅ Valid - URL is accessible\n');
    } catch (error) {
      console.log(`❌ Invalid - ${error.message}\n`);
    }
  }
}

async function runCliDemo() {
  try {
    await demonstrateWebFallback();
    await demonstrateUrlValidation();
  } catch (error) {
    console.error('CLI Demo failed:', error.message);
  }
}

if (require.main === module) {
  runCliDemo();
}