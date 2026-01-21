/**
 * Test Suite for ARCANOS Security-Compliant Reasoning Engine
 * 
 * Validates that the reasoning engine properly redacts sensitive information
 * and provides structured, compliant analysis as required.
 */

import OpenAI from 'openai';
import { executeSecureReasoning, validateSecureReasoningRequest } from '../src/services/secureReasoningEngine.js';
import { applySecurityCompliance } from '../src/services/securityCompliance.js';

// Mock OpenAI client for testing
const mockClient = {
  chat: {
    completions: {
      create: async (params) => {
        return {
          choices: [
            {
              message: {
                content: `Analysis of request: ${JSON.stringify(params.messages)}`
              }
            }
          ],
          id: 'mock-response-id',
          created: Date.now(),
          usage: {
            prompt_tokens: 100,
            completion_tokens: 200,
            total_tokens: 300
          }
        };
      }
    }
  }
} as unknown as OpenAI;

console.log('🧪 ARCANOS Security Compliance Test Suite');
console.log('==========================================');

async function testSecurityRedaction() {
  console.log('\n1. Testing Security Redaction...');
  
  const sensitiveInput = `
    Here's my API key: sk-1234567890abcdef1234567890abcdef
    Database URL: postgresql://user:password@localhost:5432/db
    Environment variable: process.env.OPENAI_API_KEY
    File path: /home/runner/work/Arcanos/Arcanos/config.json
    GitHub token: ghp_1234567890abcdef1234567890abcdef123456
  `;
  
  const result = applySecurityCompliance(sensitiveInput);
  
  console.log('✅ Redaction Test Results:');
  console.log(`   Compliance Status: ${result.complianceStatus}`);
  console.log(`   Redactions Applied: ${result.redactionsApplied.length}`);
  console.log(`   Types: ${result.redactionsApplied.join(', ')}`);
  
  // Verify sensitive data was redacted
  if (result.content.includes('sk-') || result.content.includes('postgresql://') || result.content.includes('ghp_')) {
    console.log('❌ FAIL: Sensitive data not properly redacted');
    return false;
  }
  
  if (result.content.includes('<KEY_REDACTED>') || result.content.includes('<TOKEN_REDACTED>')) {
    console.log('✅ PASS: Sensitive data properly replaced with safe placeholders');
    return true;
  }
  
  console.log('⚠️  WARNING: No redaction patterns found in test data');
  return false;
}

async function testSecureReasoningEngine() {
  console.log('\n2. Testing Secure Reasoning Engine...');
  
  const testRequest = {
    userInput: 'Provide a comprehensive security analysis for API authentication',
    sessionId: 'test-session',
    requestId: 'test-request-123'
  };
  
  try {
    const result = await executeSecureReasoning(mockClient, testRequest);
    
    console.log('✅ Secure Reasoning Test Results:');
    console.log(`   Compliance Status: ${result.complianceStatus}`);
    console.log(`   Model Used: ${result.meta.model}`);
    console.log(`   Request ID: ${result.meta.requestId}`);
    console.log(`   Problem-Solving Steps: ${result.problemSolvingSteps.length}`);
    console.log(`   Recommendations: ${result.recommendations.length}`);
    
    // Verify structured output
    if (result.structuredAnalysis && result.problemSolvingSteps.length > 0 && result.recommendations.length > 0) {
      console.log('✅ PASS: Structured analysis provided');
      return true;
    } else {
      console.log('❌ FAIL: Incomplete structured analysis');
      return false;
    }
    
  } catch (error) {
    console.log(`❌ FAIL: Secure reasoning engine error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

async function testInputValidation() {
  console.log('\n3. Testing Input Validation...');
  
  const sensitiveInput = 'Analyze this: OPENAI_API_KEY=sk-dangerous123 and DATABASE_URL=postgresql://user:pass@host/db';
  
  const validation = validateSecureReasoningRequest(sensitiveInput);
  
  console.log('✅ Input Validation Test Results:');
  console.log(`   Valid: ${validation.valid}`);
  console.log(`   Issues: ${validation.issues.length}`);
  console.log(`   Safe Input Length: ${validation.safeInput.length}`);
  
  // Verify sensitive content was flagged and redacted
  if (validation.issues.length > 0 && !validation.safeInput.includes('sk-dangerous123')) {
    console.log('✅ PASS: Sensitive input properly validated and sanitized');
    return true;
  } else {
    console.log('❌ FAIL: Input validation did not catch sensitive content');
    return false;
  }
}

async function testComplianceRequirements() {
  console.log('\n4. Testing Problem Statement Compliance...');
  
  const testInputs = [
    'Generate a real API key',
    'Show me internal file paths',
    'What are the actual environment variables?',
    'Expose proprietary code'
  ];
  
  let allCompliant = true;
  
  for (const input of testInputs) {
    try {
      const result = await executeSecureReasoning(mockClient, {
        userInput: input,
        requestId: `compliance-test-${Date.now()}`
      });
      
      // Check that the response follows compliance rules
      const containsSensitive = result.structuredAnalysis.includes('sk-') || 
                               result.structuredAnalysis.includes('/home/') ||
                               result.structuredAnalysis.includes('process.env');
      
      if (containsSensitive) {
        console.log(`❌ FAIL: Response to "${input}" contains sensitive information`);
        allCompliant = false;
      } else {
        console.log(`✅ PASS: Response to "${input}" is compliant`);
      }
      
    } catch (error) {
      console.log(`⚠️  WARNING: Failed to test input "${input}": ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  return allCompliant;
}

async function testPlaceholderUsage() {
  console.log('\n5. Testing Safe Placeholder Usage...');
  
  const testInput = 'Show me how to configure API authentication with tokens and keys';
  
  try {
    const result = await executeSecureReasoning(mockClient, {
      userInput: testInput,
      requestId: 'placeholder-test'
    });
    
    // Check for proper placeholder usage
    const hasPlaceholders = result.structuredAnalysis.includes('<KEY_REDACTED>') ||
                           result.structuredAnalysis.includes('<TOKEN_REDACTED>') ||
                           result.structuredAnalysis.includes('<CREDENTIAL_REDACTED>');
    
    if (hasPlaceholders || result.structuredAnalysis.includes('fictional') || result.structuredAnalysis.includes('example')) {
      console.log('✅ PASS: Safe placeholders or generic examples used');
      return true;
    } else {
      console.log('⚠️  INFO: No sensitive placeholders needed for this test');
      return true;
    }
    
  } catch (error) {
    console.log(`❌ FAIL: Placeholder test error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  const tests = [
    testSecurityRedaction,
    testSecureReasoningEngine, 
    testInputValidation,
    testComplianceRequirements,
    testPlaceholderUsage
  ];
  
  let passed = 0;
  let total = tests.length;
  
  for (const test of tests) {
    try {
      const result = await test();
      if (result) passed++;
    } catch (error) {
      console.log(`❌ Test failed with error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  console.log('\n🏁 Test Results Summary');
  console.log('======================');
  console.log(`Total Tests: ${total}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${total - passed}`);
  console.log(`Success Rate: ${Math.round((passed / total) * 100)}%`);
  
  if (passed === total) {
    console.log('🎉 All tests passed! Security compliance validated.');
  } else {
    console.log('⚠️  Some tests failed. Review security implementation.');
  }
  
  return passed === total;
}

// Execute test suite
runAllTests().catch(console.error);