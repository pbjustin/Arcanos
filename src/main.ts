// ARCANOS Main Entry Point - GitHub Integration Enabled
// This is the main entry point as specified in the requirements

import './index.js';
// Import the AI Reflection Scheduler to enable it
import './ai-reflection-scheduler.js';

// Export main ARCANOS interface for external usage
export { askArcanosV1_Safe, getActiveModel, ArcanosModel } from './services/arcanos-v1-interface.js';
export { githubWebhookService } from './services/github-webhook-service.js';
export { githubActionsService, executeGitHubAction } from './services/github-actions-service.js';
export { aiReflectionScheduler } from './ai-reflection-scheduler.js';

console.log('🤖 ARCANOS Main Entry Point - Full Backend Controller Ready');
console.log('📋 GitHub Integration Features:');
console.log('   ✅ onPush webhook handler');
console.log('   ✅ onPRMerged webhook handler'); 
console.log('   ✅ onTagRelease webhook handler');
console.log('   ✅ GitHub Actions trigger capability');
console.log('   ✅ Code analysis automation');
console.log('   ✅ Deployment automation');
console.log('   ✅ Release automation');
console.log('   ✅ AI Reflection Scheduler (40-minute intervals)');
console.log('🔧 DEPLOY_MODE: agent-control');
console.log('🔑 OpenAI SDK: Modular, Secured, Token-Efficient');