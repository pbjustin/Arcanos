// ARCANOS Main Entry Point - GitHub Integration Enabled
// This is the main entry point as specified in the requirements

import './index';
// Import the AI Reflection Scheduler to enable it
import './ai-reflection-scheduler';
// Import the Backend AI Reflection Handler to enable it
import './services/backend-ai-reflection-handler';

// Export main ARCANOS interface for external usage
export { askArcanosV1_Safe, getActiveModel, ArcanosModel } from './services/arcanos-v1-interface';
export { githubWebhookService } from './services/github-webhook-service';
export { githubActionsService, executeGitHubAction } from './services/github-actions-service';
export { aiReflectionScheduler } from './ai-reflection-scheduler';
export { default as backendReflectionHandler } from './services/backend-ai-reflection-handler';

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
console.log('   ✅ Backend AI Reflection Handler (2:00 AM daily)');
console.log('🔧 DEPLOY_MODE: agent-control');
console.log('🔑 OpenAI SDK: Modular, Secured, Token-Efficient');