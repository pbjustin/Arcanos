/**
 * ARCANOS Module Registry Type Definitions
 * Type definitions for the module registry system with OpenAI SDK compatibility
 */

export interface RegistryMetadata {
  name: string;
  version: string;
  description: string;
  created: string;
  last_updated: string;
  audit_enabled: boolean;
  sdk_compatibility: string;
}

export interface EnvironmentVariable {
  name: string;
  required: boolean;
  description: string;
  validation_pattern?: string;
}

export interface ModuleRequirements {
  environment_variables: EnvironmentVariable[];
  dependencies: string[];
  permissions: string[];
}

export interface OpenAIFunctionParameter {
  type: string;
  description: string;
  enum?: string[];
  default?: any;
  minimum?: number;
  maximum?: number;
}

export interface OpenAIFunctionParameters {
  type: 'object';
  properties: Record<string, OpenAIFunctionParameter>;
  required: string[];
}

export interface OpenAIFunction {
  name: string;
  description: string;
  parameters: OpenAIFunctionParameters;
}

export interface RateLimit {
  requests_per_hour: number;
}

export interface ModuleAction {
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  endpoint: string;
  openai_function: OpenAIFunction;
  audit_log: boolean;
  rate_limit: RateLimit;
}

export interface AuditConfiguration {
  enabled: boolean;
  trace_requests: boolean;
  log_responses: boolean;
  retention_days: number;
  include_metadata: boolean;
  sanitize_tokens: boolean;
  audit_fields: string[];
}

export interface VersionCompatibility {
  min_arcanos_version: string;
  max_arcanos_version: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export interface ModuleVersioning {
  current_version: string;
  api_version: string;
  compatibility: VersionCompatibility;
  changelog: ChangelogEntry[];
}

export interface ModuleSecurity {
  authentication_method: string;
  token_validation: boolean;
  rate_limiting: boolean;
  request_signing: boolean;
  allowed_origins: string[];
  timeout_ms: number;
}

export interface ModuleMonitoring {
  health_check_endpoint: string;
  metrics_enabled: boolean;
  performance_tracking: boolean;
  error_reporting: boolean;
}

export interface ModuleMetadata {
  name: string;
  display_name: string;
  version: string;
  description: string;
  provider: string;
  category: string;
  status: 'active' | 'inactive' | 'deprecated';
  created: string;
  last_updated: string;
  author: string;
  tags: string[];
}

export interface ArcanosModule {
  metadata: ModuleMetadata;
  requirements: ModuleRequirements;
  actions: Record<string, ModuleAction>;
  audit_configuration: AuditConfiguration;
  versioning: ModuleVersioning;
  security: ModuleSecurity;
  monitoring: ModuleMonitoring;
}

export interface ModuleRegistry {
  registry_metadata: RegistryMetadata;
  modules: Record<string, ArcanosModule>;
}

/**
 * OpenAI SDK-compatible function tools for GitHub module actions
 */
export interface GitHubModuleTools {
  github_create_repo: OpenAIFunction;
  github_commit_file: OpenAIFunction;
  github_open_pr: OpenAIFunction;
  github_list_issues: OpenAIFunction;
}

/**
 * Helper function to extract OpenAI tools from module registry
 */
export function extractOpenAITools(module: ArcanosModule): GitHubModuleTools {
  const tools: any = {};
  
  Object.entries(module.actions).forEach(([actionKey, action]) => {
    tools[action.openai_function.name] = action.openai_function;
  });
  
  return tools as GitHubModuleTools;
}

/**
 * Helper function to validate module registry structure
 */
export function validateModuleRegistry(registry: any): registry is ModuleRegistry {
  try {
    // Basic structure validation
    if (!registry.registry_metadata || !registry.modules) {
      return false;
    }
    
    // Check required metadata fields
    const metadata = registry.registry_metadata;
    const requiredMetadataFields = ['name', 'version', 'description', 'created', 'last_updated', 'audit_enabled', 'sdk_compatibility'];
    if (!requiredMetadataFields.every(field => metadata[field] !== undefined)) {
      return false;
    }
    
    // Validate each module
    for (const [moduleName, module] of Object.entries(registry.modules)) {
      if (!module || typeof module !== 'object') {
        return false;
      }
      
      const mod = module as ArcanosModule;
      
      // Check required module sections
      if (!mod.metadata || !mod.requirements || !mod.actions || !mod.audit_configuration || !mod.versioning || !mod.security || !mod.monitoring) {
        return false;
      }
      
      // Validate actions have OpenAI functions
      for (const [actionName, action] of Object.entries(mod.actions)) {
        if (!action.openai_function || !action.openai_function.name || !action.openai_function.parameters) {
          return false;
        }
      }
    }
    
    return true;
  } catch (error) {
    return false;
  }
}

export default ModuleRegistry;