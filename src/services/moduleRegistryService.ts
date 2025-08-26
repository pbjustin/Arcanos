/**
 * ARCANOS Module Registry Service
 * Provides access to the module registry with OpenAI SDK integration
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { 
  ModuleRegistry, 
  ArcanosModule, 
  ModuleAction,
  OpenAIFunction,
  validateModuleRegistry,
  extractOpenAITools 
} from '../types/moduleRegistry.js';

// Get the directory of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ModuleRegistryService {
  private registry: ModuleRegistry | null = null;
  private registryPath: string;

  constructor(registryPath?: string) {
    this.registryPath = registryPath || path.resolve(__dirname, '../config/modules-registry.json');
  }

  /**
   * Load the module registry from file
   */
  public loadRegistry(): ModuleRegistry {
    try {
      if (!fs.existsSync(this.registryPath)) {
        throw new Error(`Module registry file not found: ${this.registryPath}`);
      }

      const registryData = fs.readFileSync(this.registryPath, 'utf-8');
      const parsedRegistry = JSON.parse(registryData);

      if (!validateModuleRegistry(parsedRegistry)) {
        throw new Error('Invalid module registry structure');
      }

      this.registry = parsedRegistry;
      console.log(`✅ Module registry loaded successfully with ${Object.keys(this.registry.modules).length} modules`);
      
      return this.registry;
    } catch (error) {
      console.error('❌ Failed to load module registry:', error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Get the full registry
   */
  public getRegistry(): ModuleRegistry {
    if (!this.registry) {
      return this.loadRegistry();
    }
    return this.registry;
  }

  /**
   * Get a specific module by name
   */
  public getModule(moduleName: string): ArcanosModule | null {
    const registry = this.getRegistry();
    return registry.modules[moduleName] || null;
  }

  /**
   * Get all available modules
   */
  public getAllModules(): Record<string, ArcanosModule> {
    const registry = this.getRegistry();
    return registry.modules;
  }

  /**
   * Get module action by module name and action name
   */
  public getModuleAction(moduleName: string, actionName: string): ModuleAction | null {
    const module = this.getModule(moduleName);
    if (!module) {
      return null;
    }
    return module.actions[actionName] || null;
  }

  /**
   * Get OpenAI-compatible function definitions for a module
   */
  public getOpenAIFunctions(moduleName: string): OpenAIFunction[] {
    const module = this.getModule(moduleName);
    if (!module) {
      return [];
    }

    return Object.values(module.actions).map(action => action.openai_function);
  }

  /**
   * Get all OpenAI-compatible function definitions for all modules
   */
  public getAllOpenAIFunctions(): OpenAIFunction[] {
    const registry = this.getRegistry();
    const functions: OpenAIFunction[] = [];

    Object.values(registry.modules).forEach(module => {
      Object.values(module.actions).forEach(action => {
        functions.push(action.openai_function);
      });
    });

    return functions;
  }

  /**
   * Check if a module exists and is active
   */
  public isModuleActive(moduleName: string): boolean {
    const module = this.getModule(moduleName);
    return module ? module.metadata.status === 'active' : false;
  }

  /**
   * Get module metadata
   */
  public getModuleMetadata(moduleName: string) {
    const module = this.getModule(moduleName);
    return module ? module.metadata : null;
  }

  /**
   * Validate environment variables for a module
   */
  public validateModuleEnvironment(moduleName: string): { valid: boolean; missing: string[]; invalid: string[] } {
    const module = this.getModule(moduleName);
    if (!module) {
      return { valid: false, missing: [], invalid: ['Module not found'] };
    }

    const missing: string[] = [];
    const invalid: string[] = [];

    module.requirements.environment_variables.forEach(envVar => {
      const value = process.env[envVar.name];
      
      if (envVar.required && !value) {
        missing.push(envVar.name);
      } else if (value && envVar.validation_pattern) {
        const regex = new RegExp(envVar.validation_pattern);
        if (!regex.test(value)) {
          invalid.push(envVar.name);
        }
      }
    });

    return {
      valid: missing.length === 0 && invalid.length === 0,
      missing,
      invalid
    };
  }

  /**
   * Get module statistics
   */
  public getModuleStats() {
    const registry = this.getRegistry();
    const modules = Object.values(registry.modules);

    return {
      total_modules: modules.length,
      active_modules: modules.filter(m => m.metadata.status === 'active').length,
      total_actions: modules.reduce((sum, m) => sum + Object.keys(m.actions).length, 0),
      providers: [...new Set(modules.map(m => m.metadata.provider))],
      categories: [...new Set(modules.map(m => m.metadata.category))]
    };
  }

  /**
   * Create OpenAI SDK-compatible tools configuration for chat completions
   */
  public createOpenAIToolsConfig(moduleNames?: string[]): any[] {
    let functions: OpenAIFunction[];
    
    if (moduleNames) {
      functions = [];
      moduleNames.forEach(moduleName => {
        functions.push(...this.getOpenAIFunctions(moduleName));
      });
    } else {
      functions = this.getAllOpenAIFunctions();
    }

    return functions.map(func => ({
      type: 'function',
      function: func
    }));
  }

  /**
   * Get GitHub module specifically (convenience method)
   */
  public getGitHubModule(): ArcanosModule | null {
    return this.getModule('ARCANOS:GITHUB');
  }

  /**
   * Get GitHub OpenAI functions (convenience method)
   */
  public getGitHubOpenAIFunctions(): OpenAIFunction[] {
    return this.getOpenAIFunctions('ARCANOS:GITHUB');
  }
}

// Export singleton instance
export const moduleRegistryService = new ModuleRegistryService();

// Export class for custom instances
export { ModuleRegistryService };

export default moduleRegistryService;