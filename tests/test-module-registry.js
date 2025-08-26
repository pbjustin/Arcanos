/**
 * Module Registry Test
 * Tests the GitHub module registry entry and service functionality
 */

import { moduleRegistryService } from '../dist/services/moduleRegistryService.js';
import { validateModuleRegistry } from '../dist/types/moduleRegistry.js';

async function testModuleRegistry() {
  console.log('🧪 Testing ARCANOS Module Registry...\n');

  try {
    // Test 1: Load and validate registry
    console.log('1. Loading and validating registry...');
    const registry = moduleRegistryService.loadRegistry();
    
    console.log(`   ✅ Registry loaded successfully`);
    console.log(`   📊 Registry metadata: ${registry.registry_metadata.name} v${registry.registry_metadata.version}`);
    console.log(`   🔗 SDK compatibility: ${registry.registry_metadata.sdk_compatibility}`);

    // Test 2: Check GitHub module
    console.log('\n2. Testing GitHub module...');
    const githubModule = moduleRegistryService.getGitHubModule();
    
    if (!githubModule) {
      throw new Error('ARCANOS:GITHUB module not found');
    }
    
    console.log(`   ✅ GitHub module found: ${githubModule.metadata.display_name}`);
    console.log(`   📝 Description: ${githubModule.metadata.description}`);
    console.log(`   🏷️  Provider: ${githubModule.metadata.provider}`);
    console.log(`   📅 Version: ${githubModule.metadata.version}`);

    // Test 3: Check required actions
    console.log('\n3. Testing required actions...');
    const requiredActions = ['createRepo', 'commitFile', 'openPR', 'listIssues'];
    const availableActions = Object.keys(githubModule.actions);
    
    console.log(`   📋 Available actions: ${availableActions.join(', ')}`);
    
    for (const action of requiredActions) {
      if (githubModule.actions[action]) {
        console.log(`   ✅ Action '${action}' found`);
      } else {
        throw new Error(`Required action '${action}' not found`);
      }
    }

    // Test 4: Check environment variables
    console.log('\n4. Testing environment variables...');
    const requiredEnvVars = ['GITHUB_TOKEN', 'GITHUB_USER'];
    const configuredEnvVars = githubModule.requirements.environment_variables.map(ev => ev.name);
    
    console.log(`   🔧 Configured env vars: ${configuredEnvVars.join(', ')}`);
    
    for (const envVar of requiredEnvVars) {
      if (configuredEnvVars.includes(envVar)) {
        console.log(`   ✅ Environment variable '${envVar}' configured`);
      } else {
        throw new Error(`Required environment variable '${envVar}' not configured`);
      }
    }

    // Test 5: Test OpenAI function compatibility
    console.log('\n5. Testing OpenAI SDK compatibility...');
    const openAIFunctions = moduleRegistryService.getGitHubOpenAIFunctions();
    
    console.log(`   🔗 OpenAI functions count: ${openAIFunctions.length}`);
    
    for (const func of openAIFunctions) {
      console.log(`   📦 Function: ${func.name}`);
      console.log(`      📝 Description: ${func.description}`);
      console.log(`      🔧 Parameters: ${func.parameters.required.join(', ')}`);
      
      // Validate function structure
      if (!func.name || !func.description || !func.parameters) {
        throw new Error(`Invalid OpenAI function structure for ${func.name}`);
      }
      
      if (func.parameters.type !== 'object' || !func.parameters.properties || !Array.isArray(func.parameters.required)) {
        throw new Error(`Invalid parameters structure for function ${func.name}`);
      }
    }

    // Test 6: Create OpenAI tools configuration
    console.log('\n6. Testing OpenAI tools configuration...');
    const toolsConfig = moduleRegistryService.createOpenAIToolsConfig(['ARCANOS:GITHUB']);
    
    console.log(`   🛠️  Tools config generated: ${toolsConfig.length} tools`);
    
    for (const tool of toolsConfig) {
      if (tool.type !== 'function' || !tool.function) {
        throw new Error('Invalid tool configuration structure');
      }
      console.log(`   ✅ Tool: ${tool.function.name} (${tool.type})`);
    }

    // Test 7: Environment validation
    console.log('\n7. Testing environment validation...');
    const envValidation = moduleRegistryService.validateModuleEnvironment('ARCANOS:GITHUB');
    
    console.log(`   🔍 Environment validation result:`);
    console.log(`      Valid: ${envValidation.valid}`);
    console.log(`      Missing vars: ${envValidation.missing.length > 0 ? envValidation.missing.join(', ') : 'none'}`);
    console.log(`      Invalid vars: ${envValidation.invalid.length > 0 ? envValidation.invalid.join(', ') : 'none'}`);

    // Test 8: Module statistics
    console.log('\n8. Testing module statistics...');
    const stats = moduleRegistryService.getModuleStats();
    
    console.log(`   📊 Module statistics:`);
    console.log(`      Total modules: ${stats.total_modules}`);
    console.log(`      Active modules: ${stats.active_modules}`);
    console.log(`      Total actions: ${stats.total_actions}`);
    console.log(`      Providers: ${stats.providers.join(', ')}`);
    console.log(`      Categories: ${stats.categories.join(', ')}`);

    // Test 9: Audit configuration
    console.log('\n9. Testing audit configuration...');
    const auditConfig = githubModule.audit_configuration;
    
    console.log(`   📋 Audit enabled: ${auditConfig.enabled}`);
    console.log(`   🔍 Trace requests: ${auditConfig.trace_requests}`);
    console.log(`   📝 Log responses: ${auditConfig.log_responses}`);
    console.log(`   📅 Retention days: ${auditConfig.retention_days}`);
    console.log(`   🔒 Sanitize tokens: ${auditConfig.sanitize_tokens}`);

    console.log('\n🎉 All tests passed! GitHub module registry entry is valid and OpenAI SDK-compatible.');
    
    return true;
  } catch (error) {
    console.error('\n❌ Test failed:', error instanceof Error ? error.message : 'Unknown error');
    return false;
  }
}

// Export for use in other test files
export { testModuleRegistry };

// Run tests if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testModuleRegistry().then(success => {
    process.exit(success ? 0 : 1);
  });
}