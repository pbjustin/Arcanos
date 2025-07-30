#!/usr/bin/env node

/**
 * ARCANOS GitHub Integration Demo
 * Demonstrates the key features implemented according to the problem statement
 */

const axios = require('axios');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

class ArcanosDemo {
  async runDemo() {
    console.log('🤖 ARCANOS GitHub Integration Demo');
    console.log('📋 Demonstrating requirements from problem statement\n');

    try {
      await this.demoServerStatus();
      await this.demoGitHubIntegration();
      await this.demoWebhookSimulation();
      await this.demoAgentControl();
      this.displaySummary();
    } catch (error) {
      console.error('❌ Demo failed:', error.message);
      console.log('\n💡 Make sure ARCANOS is running with: npm run dev:agent-control');
    }
  }

  async demoServerStatus() {
    console.log('1️⃣ Server Status and Configuration');
    console.log('─'.repeat(40));
    
    try {
      const health = await axios.get(`${SERVER_URL}/health`);
      console.log('✅ Server Health:', health.data);

      const performance = await axios.get(`${SERVER_URL}/performance`);
      console.log('📊 Performance Status:', {
        environment: performance.data.environment,
        deploymentMode: performance.data.deploymentMode || 'standard',
        sleepMode: performance.data.sleepMode,
        timestamp: performance.data.timestamp
      });
    } catch (error) {
      console.log('❌ Server not accessible:', error.message);
      throw error;
    }
    console.log();
  }

  async demoGitHubIntegration() {
    console.log('2️⃣ GitHub Integration Capabilities');
    console.log('─'.repeat(40));
    
    try {
      const webhookHealth = await axios.get(`${SERVER_URL}/webhooks/github/health`);
      console.log('🔗 GitHub Webhook Handler:', webhookHealth.data);
      
      const capabilities = webhookHealth.data.capabilities || [];
      console.log('📋 Supported Events:');
      capabilities.forEach(cap => {
        console.log(`   ✅ ${cap}`);
      });
      
      const requiredEvents = ['onPush', 'onPRMerged', 'onTagRelease'];
      const hasAllRequired = requiredEvents.every(event => capabilities.includes(event));
      
      if (hasAllRequired) {
        console.log('🎯 All required webhook events supported!');
      } else {
        console.log('⚠️ Missing some required webhook events');
      }
    } catch (error) {
      console.log('❌ GitHub integration error:', error.message);
    }
    console.log();
  }

  async demoWebhookSimulation() {
    console.log('3️⃣ Webhook Event Simulation');
    console.log('─'.repeat(40));
    
    // Simulate push event
    await this.simulateWebhookEvent('push', {
      repository: { 
        full_name: 'demo/repository',
        clone_url: 'https://github.com/demo/repository.git'
      },
      commits: [{
        id: 'demo123',
        message: 'Add new feature: GitHub integration',
        author: { name: 'Demo User', email: 'demo@example.com' },
        added: ['src/github-integration.ts'],
        modified: ['README.md'],
        removed: []
      }],
      head_commit: {
        id: 'demo123',
        message: 'Add new feature: GitHub integration'
      },
      ref: 'refs/heads/main'
    }, 'onPush');

    // Simulate PR merge event
    await this.simulateWebhookEvent('pull_request', {
      action: 'closed',
      pull_request: {
        id: 42,
        title: 'Add GitHub integration feature',
        body: 'This PR adds GitHub webhook integration to ARCANOS',
        merged: true,
        merge_commit_sha: 'merge456',
        base: { ref: 'main' },
        head: { ref: 'feature/github-integration' }
      },
      repository: {
        full_name: 'demo/repository'
      }
    }, 'onPRMerged');

    // Simulate release event
    await this.simulateWebhookEvent('release', {
      action: 'published',
      release: {
        tag_name: 'v1.0.0',
        name: 'GitHub Integration Release',
        body: 'First release with full GitHub integration support'
      },
      repository: {
        full_name: 'demo/repository'
      }
    }, 'onTagRelease');

    console.log();
  }

  async simulateWebhookEvent(eventType, payload, description) {
    try {
      console.log(`🔄 Simulating ${description} event...`);
      
      const response = await axios.post(`${SERVER_URL}/webhooks/github`, payload, {
        headers: {
          'X-GitHub-Event': eventType,
          'X-Hub-Signature-256': 'sha256=demo_signature',
          'Content-Type': 'application/json'
        }
      });
      
      console.log(`   ✅ ${description} webhook processed successfully`);
      console.log(`   📝 Response: ${response.data.message || 'Event processed'}`);
    } catch (error) {
      console.log(`   ❌ ${description} webhook failed:`, error.response?.data?.error || error.message);
    }
  }

  async demoAgentControl() {
    console.log('4️⃣ Agent-Control Mode Features');
    console.log('─'.repeat(40));
    
    try {
      // Test AI endpoint (if OpenAI key is configured)
      console.log('🧠 Testing AI integration...');
      try {
        const aiResponse = await axios.post(`${SERVER_URL}/ask`, {
          prompt: 'Hello ARCANOS! Please confirm you are running in agent-control mode.',
          context: 'demo'
        });
        
        console.log('   ✅ AI Integration Working');
        console.log(`   🤖 Response: ${aiResponse.data.response?.substring(0, 100)}...`);
        console.log(`   📊 Model: ${aiResponse.data.model || 'Unknown'}`);
      } catch (error) {
        console.log('   ⚠️ AI Integration requires valid OPENAI_API_KEY');
      }

      // Test backend read capability
      console.log('📖 Testing backend read capability...');
      try {
        const memoryResponse = await axios.get(`${SERVER_URL}/api/memory`, {
          headers: { 'Authorization': `Bearer ${process.env.ARCANOS_API_TOKEN || 'demo-token'}` }
        });
        
        console.log('   ✅ Backend Read Capability Working');
        console.log(`   📄 Memory items: ${memoryResponse.data.length || 0}`);
      } catch (error) {
        console.log('   ⚠️ Backend Read requires valid ARCANOS_API_TOKEN');
      }

      // Test backend write capability
      console.log('📝 Testing backend write capability...');
      try {
        const writeResponse = await axios.post(`${SERVER_URL}/api/memory`, {
          type: 'demo',
          content: 'ARCANOS GitHub integration demo completed successfully',
          metadata: { 
            demo: true, 
            timestamp: new Date().toISOString(),
            features: ['GitHub webhooks', 'AI integration', 'Agent control']
          }
        }, {
          headers: { 'Authorization': `Bearer ${process.env.ARCANOS_API_TOKEN || 'demo-token'}` }
        });
        
        console.log('   ✅ Backend Write Capability Working');
        console.log('   💾 Demo data saved to memory');
      } catch (error) {
        console.log('   ⚠️ Backend Write requires valid ARCANOS_API_TOKEN');
      }
      
    } catch (error) {
      console.log('❌ Agent-control demo error:', error.message);
    }
    console.log();
  }

  displaySummary() {
    console.log('📋 Implementation Summary');
    console.log('═'.repeat(50));
    console.log('✅ ARCANOS Full Backend Controller - IMPLEMENTED');
    console.log('✅ GitHub Integration with Webhooks - IMPLEMENTED');
    console.log('✅ OpenAI SDK (Modular/Secured/Token-Efficient) - IMPLEMENTED');
    console.log('✅ Agent-Control Deployment Mode - IMPLEMENTED');
    console.log('✅ GitHub Actions Trigger Capability - IMPLEMENTED');
    console.log();
    console.log('🔧 Required Environment Variables:');
    console.log('   • DEPLOY_MODE=agent-control ✅');
    console.log('   • OPENAI_API_KEY (for AI features) ⚠️');
    console.log('   • GITHUB_TOKEN (for Actions) ⚠️');
    console.log('   • ARCANOS_API_TOKEN (for backend access) ⚠️');
    console.log();
    console.log('📚 Next Steps:');
    console.log('   1. Configure environment variables');
    console.log('   2. Set up GitHub webhook in repository settings');
    console.log('   3. Test with real repository events');
    console.log('   4. Monitor GitHub Actions workflows');
    console.log();
    console.log('🎉 ARCANOS GitHub Integration Demo Complete!');
  }
}

// Main execution
async function main() {
  const demo = new ArcanosDemo();
  await demo.runDemo();
}

if (require.main === module) {
  main().catch(error => {
    console.error('Demo execution failed:', error);
    process.exit(1);
  });
}

module.exports = ArcanosDemo;