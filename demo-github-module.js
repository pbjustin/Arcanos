/**
 * ARCANOS GitHub Module Integration Demo
 * Demonstrates how to use the GitHub module registry with OpenAI SDK
 */

import { moduleRegistryService } from './dist/services/moduleRegistryService.js';

async function demonstrateGitHubModule() {
  console.log('🎯 ARCANOS GitHub Module Integration Demo\n');

  try {
    // Load the module registry
    console.log('1. Loading module registry...');
    const registry = moduleRegistryService.getRegistry();
    console.log(`   ✅ Loaded registry: ${registry.registry_metadata.name}`);

    // Get GitHub module
    console.log('\n2. Accessing GitHub module...');
    const githubModule = moduleRegistryService.getGitHubModule();
    if (!githubModule) {
      throw new Error('GitHub module not found');
    }
    console.log(`   ✅ Module: ${githubModule.metadata.display_name}`);
    console.log(`   🏷️  Provider: ${githubModule.metadata.provider}`);

    // Generate OpenAI SDK-compatible tools configuration
    console.log('\n3. Creating OpenAI SDK tools configuration...');
    const toolsConfig = moduleRegistryService.createOpenAIToolsConfig(['ARCANOS:GITHUB']);
    
    console.log('   📝 Generated OpenAI tools configuration:');
    console.log(JSON.stringify(toolsConfig, null, 2));

    // Show how this would be used with OpenAI SDK
    console.log('\n4. Example OpenAI SDK integration:');
    console.log(`
    // Example: Using with OpenAI chat completions
    import OpenAI from 'openai';
    import { moduleRegistryService } from './services/moduleRegistryService.js';
    
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    
    // Get GitHub module tools
    const githubTools = moduleRegistryService.createOpenAIToolsConfig(['ARCANOS:GITHUB']);
    
    // Create chat completion with GitHub functions
    const response = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { 
          role: 'user', 
          content: 'Create a new repository called "my-project" and add a README file' 
        }
      ],
      tools: githubTools,
      tool_choice: 'auto'
    });
    
    // The AI can now call GitHub functions:
    // - github_create_repo
    // - github_commit_file  
    // - github_open_pr
    // - github_list_issues
    `);

    // Show environment validation
    console.log('\n5. Environment validation:');
    const envCheck = moduleRegistryService.validateModuleEnvironment('ARCANOS:GITHUB');
    console.log(`   🔍 Environment valid: ${envCheck.valid}`);
    if (!envCheck.valid) {
      console.log(`   ⚠️  Missing vars: ${envCheck.missing.join(', ')}`);
      console.log(`   💡 To use GitHub module, set these environment variables:`);
      githubModule.requirements.environment_variables.forEach(envVar => {
        console.log(`      export ${envVar.name}=your_${envVar.name.toLowerCase()}`);
      });
    }

    // Show audit features
    console.log('\n6. Audit and monitoring features:');
    const auditConfig = githubModule.audit_configuration;
    console.log(`   📋 Audit logging: ${auditConfig.enabled ? 'Enabled' : 'Disabled'}`);
    console.log(`   🔍 Request tracing: ${auditConfig.trace_requests ? 'Enabled' : 'Disabled'}`);
    console.log(`   📅 Log retention: ${auditConfig.retention_days} days`);
    console.log(`   🔒 Token sanitization: ${auditConfig.sanitize_tokens ? 'Enabled' : 'Disabled'}`);

    // Show versioning info
    console.log('\n7. Module versioning:');
    const versioning = githubModule.versioning;
    console.log(`   📦 Current version: ${versioning.current_version}`);
    console.log(`   🔗 API version: ${versioning.api_version}`);
    console.log(`   🎯 Compatible with ARCANOS: ${versioning.compatibility.min_arcanos_version} - ${versioning.compatibility.max_arcanos_version}`);

    console.log('\n🎉 Demo completed successfully! The GitHub module is fully integrated and ready for use.');
    
  } catch (error) {
    console.error('\n❌ Demo failed:', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
  
  return true;
}

// Export for use in other files
export { demonstrateGitHubModule };

// Run demo if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateGitHubModule().then(success => {
    process.exit(success ? 0 : 1);
  });
}