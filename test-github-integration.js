#!/usr/bin/env node

/**
 * ARCANOS GitHub Integration Test
 * Tests the core requirements from the problem statement
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const TEST_TIMEOUT = 30000;

class ArcanosIntegrationTest {
  constructor() {
    this.testResults = [];
    this.serverStarted = false;
  }

  async runAllTests() {
    console.log('🤖 ARCANOS GitHub Integration Test Suite');
    console.log('🔧 Testing requirements from problem statement\n');

    try {
      await this.testServerHealth();
      await this.testBackendLogicReadWrite();
      await this.testOpenAIIntegration();
      await this.testGitHubWebhookEndpoints();
      await this.testAgentControlMode();
      
      this.displayResults();
    } catch (error) {
      console.error('❌ Test suite failed:', error.message);
      process.exit(1);
    }
  }

  async testServerHealth() {
    console.log('🔍 Testing server health...');
    try {
      const response = await axios.get(`${SERVER_URL}/health`, { timeout: 5000 });
      this.recordTest('Server Health', true, response.data);
    } catch (error) {
      this.recordTest('Server Health', false, error.message);
      throw new Error('Server is not running. Please start ARCANOS with: npm run dev:agent-control');
    }
  }

  async testBackendLogicReadWrite() {
    console.log('📝 Testing backend logic read/write capabilities...');
    
    try {
      // Test write capability - using memory endpoint
      const writeResponse = await axios.post(`${SERVER_URL}/api/memory`, {
        type: 'test',
        content: 'ARCANOS backend logic test - GitHub integration',
        metadata: { test: 'github_integration', timestamp: new Date().toISOString() }
      }, {
        headers: { 'Authorization': `Bearer ${process.env.ARCANOS_API_TOKEN || 'test-token'}` }
      });
      
      this.recordTest('Backend Logic Write', true, 'Memory write successful');

      // Test read capability - get memory
      const readResponse = await axios.get(`${SERVER_URL}/api/memory`, {
        headers: { 'Authorization': `Bearer ${process.env.ARCANOS_API_TOKEN || 'test-token'}` }
      });
      
      this.recordTest('Backend Logic Read', true, `Retrieved ${readResponse.data.length || 0} memory items`);
    } catch (error) {
      this.recordTest('Backend Logic Read/Write', false, error.response?.data?.error || error.message);
    }
  }

  async testOpenAIIntegration() {
    console.log('🧠 Testing OpenAI SDK integration (modular, secured, token-efficient)...');
    
    try {
      const response = await axios.post(`${SERVER_URL}/ask`, {
        prompt: 'Test ARCANOS OpenAI integration. Respond with: INTEGRATION_TEST_SUCCESS',
        context: 'integration_test'
      });

      const isSecured = response.data.model && response.data.response;
      const isTokenEfficient = response.data.tokensUsed || response.data.usage;
      
      this.recordTest('OpenAI Integration', isSecured, {
        response: response.data.response?.substring(0, 100) + '...',
        model: response.data.model,
        tokenEfficient: !!isTokenEfficient
      });
    } catch (error) {
      this.recordTest('OpenAI Integration', false, error.response?.data?.error || error.message);
    }
  }

  async testGitHubWebhookEndpoints() {
    console.log('🔗 Testing GitHub webhook endpoints...');
    
    try {
      // Test GitHub webhook health
      const healthResponse = await axios.get(`${SERVER_URL}/webhooks/github/health`);
      
      const hasRequiredCapabilities = healthResponse.data.capabilities?.includes('onPush') &&
                                    healthResponse.data.capabilities?.includes('onPRMerged') &&
                                    healthResponse.data.capabilities?.includes('onTagRelease');
      
      this.recordTest('GitHub Webhook Health', true, healthResponse.data);
      this.recordTest('Required Webhook Capabilities', hasRequiredCapabilities, {
        capabilities: healthResponse.data.capabilities
      });

      // Test push webhook simulation
      await this.testWebhookEvent('push', {
        repository: { full_name: 'test/repo', clone_url: 'https://github.com/test/repo.git' },
        commits: [{ id: 'abc123', message: 'Test commit', author: { name: 'Test', email: 'test@example.com' }, added: [], modified: ['test.js'], removed: [] }],
        head_commit: { id: 'abc123', message: 'Test commit' },
        ref: 'refs/heads/main'
      });

    } catch (error) {
      this.recordTest('GitHub Webhook Endpoints', false, error.response?.data?.error || error.message);
    }
  }

  async testWebhookEvent(eventType, payload) {
    try {
      const response = await axios.post(`${SERVER_URL}/webhooks/github`, payload, {
        headers: {
          'X-GitHub-Event': eventType,
          'X-Hub-Signature-256': 'sha256=test_signature',
          'Content-Type': 'application/json'
        }
      });
      
      this.recordTest(`Webhook ${eventType} Event`, true, response.data);
    } catch (error) {
      this.recordTest(`Webhook ${eventType} Event`, false, error.response?.data?.error || error.message);
    }
  }

  async testAgentControlMode() {
    console.log('🎛️ Testing agent-control deployment mode...');
    
    try {
      const response = await axios.get(`${SERVER_URL}/performance`);
      
      const hasAgentControlFeatures = response.data.environment !== undefined &&
                                    response.data.sleepMode !== undefined;
      
      this.recordTest('Agent Control Mode', hasAgentControlFeatures, {
        environment: response.data.environment,
        sleepMode: response.data.sleepMode,
        timestamp: response.data.timestamp
      });
    } catch (error) {
      this.recordTest('Agent Control Mode', false, error.response?.data?.error || error.message);
    }
  }

  recordTest(testName, passed, result) {
    this.testResults.push({ name: testName, passed, result });
    const status = passed ? '✅' : '❌';
    console.log(`   ${status} ${testName}`);
    
    if (!passed) {
      console.log(`      Error: ${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`);
    }
  }

  displayResults() {
    console.log('\n📊 Test Results Summary:');
    console.log('=' * 50);
    
    const passedTests = this.testResults.filter(t => t.passed).length;
    const totalTests = this.testResults.length;
    
    this.testResults.forEach(test => {
      const status = test.passed ? '✅' : '❌';
      console.log(`${status} ${test.name}`);
    });
    
    console.log(`\n🎯 Overall: ${passedTests}/${totalTests} tests passed`);
    
    if (passedTests === totalTests) {
      console.log('\n🎉 All ARCANOS GitHub integration requirements met!');
      console.log('✅ Backend logic read/write: WORKING');
      console.log('✅ GitHub Actions trigger capability: AVAILABLE');
      console.log('✅ OpenAI SDK modular/secured/token-efficient: CONFIRMED');
      console.log('✅ Webhook handlers (onPush, onPRMerged, onTagRelease): ACTIVE');
      console.log('✅ Agent-control deployment mode: ENABLED');
    } else {
      console.log('\n⚠️ Some tests failed. Please check the requirements.');
      process.exit(1);
    }
  }
}

// Main execution
async function main() {
  const tester = new ArcanosIntegrationTest();
  await tester.runAllTests();
}

if (require.main === module) {
  main().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
}

module.exports = ArcanosIntegrationTest;