/**
 * GitHub Module Integration Example
 * Shows how to integrate the GitHub module with existing ARCANOS OpenAI service
 */

import { moduleRegistryService } from '../services/moduleRegistryService.js';
import { getOpenAIClient } from '../services/openai.js';

/**
 * Example: Create a GitHub repository using the ARCANOS module registry
 */
export async function createGitHubRepoWithAI(prompt: string) {
  try {
    // Get OpenAI client from existing service
    const client = getOpenAIClient();
    if (!client) {
      throw new Error('OpenAI client not available');
    }

    // Get GitHub tools from module registry
    const githubTools = moduleRegistryService.createOpenAIToolsConfig(['ARCANOS:GITHUB']);
    
    // Validate GitHub module environment
    const envCheck = moduleRegistryService.validateModuleEnvironment('ARCANOS:GITHUB');
    if (!envCheck.valid) {
      throw new Error(`GitHub module environment not configured: Missing ${envCheck.missing.join(', ')}`);
    }

    console.log('🤖 Creating GitHub repository with AI assistance...');

    // Call OpenAI with GitHub tools
    const response = await client.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are an AI assistant that helps with GitHub repository management. Use the provided GitHub functions to help users create and manage repositories.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      tools: githubTools,
      tool_choice: 'auto'
    });

    const message = response.choices[0]?.message;
    
    if (message?.tool_calls) {
      console.log('🔧 AI requested GitHub function calls:');
      for (const toolCall of message.tool_calls) {
        if (toolCall.type === 'function') {
          console.log(`   📦 Function: ${toolCall.function.name}`);
          console.log(`   📝 Arguments: ${toolCall.function.arguments}`);
          
          // Here you would implement the actual GitHub API calls
          // using the arguments provided by the AI
          console.log('   ✅ Would execute GitHub API call with these parameters');
        }
      }
    }

    return {
      message: message?.content,
      tool_calls: message?.tool_calls,
      activeModel: response.model
    };

  } catch (error) {
    console.error('❌ GitHub repository creation failed:', error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Example: Get GitHub module information for API documentation
 */
export function getGitHubModuleAPIDocumentation() {
  const githubModule = moduleRegistryService.getGitHubModule();
  if (!githubModule) {
    throw new Error('GitHub module not found');
  }

  const documentation = {
    module: githubModule.metadata,
    actions: Object.entries(githubModule.actions).map(([key, action]) => ({
      name: key,
      description: action.description,
      method: action.method,
      endpoint: action.endpoint,
      openai_function: action.openai_function,
      rate_limit: action.rate_limit
    })),
    requirements: githubModule.requirements,
    audit: githubModule.audit_configuration
  };

  return documentation;
}

/**
 * Integration with existing ARCANOS audit system
 */
export async function logGitHubModuleUsage(action: string, parameters: any, result: any) {
  const githubModule = moduleRegistryService.getGitHubModule();
  if (!githubModule?.audit_configuration.enabled) {
    return;
  }

  const auditLog = {
    timestamp: new Date().toISOString(),
    module: 'ARCANOS:GITHUB',
    action,
    parameters: githubModule.audit_configuration.sanitize_tokens ? 
      sanitizeParameters(parameters) : parameters,
    result: githubModule.audit_configuration.log_responses ? result : { status: 'completed' },
    request_id: crypto.randomUUID()
  };

  // Log to ARCANOS audit system (would integrate with existing audit logging)
  console.log('📋 GitHub module audit log:', JSON.stringify(auditLog, null, 2));
  
  return auditLog;
}

/**
 * Helper function to sanitize sensitive parameters
 */
function sanitizeParameters(params: any): any {
  const sanitized = { ...params };
  
  // Remove or mask sensitive fields
  if (sanitized.token) sanitized.token = '[REDACTED]';
  if (sanitized.password) sanitized.password = '[REDACTED]';
  if (sanitized.secret) sanitized.secret = '[REDACTED]';
  
  return sanitized;
}

export default {
  createGitHubRepoWithAI,
  getGitHubModuleAPIDocumentation,
  logGitHubModuleUsage
};