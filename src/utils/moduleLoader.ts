import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Express, Router } from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ModuleInfo {
  filename: string;
  path: string;
  router: Router;
  loadedAt: string;
}

interface LoadedModuleInfo {
  name: string;
  filename: string;
  loadedAt: string;
}

/**
 * Dynamic module loader for ARCANOS backend
 * Scans ./modules/ directory and dynamically imports all valid modules
 */
export class ModuleLoader {
  private app: Express;
  private modulesDir: string;
  private loadedModules: Map<string, ModuleInfo>;
  // Note: Core modules (write, guide, audit, sim) are now handled by TypeScript routes in ai-endpoints.ts
  // Only custom extension modules should be loaded from /modules directory
  private requiredModules: string[] = [];

  constructor(app: Express, modulesDir: string | null = null) {
    this.app = app;
    this.modulesDir = modulesDir || path.join(process.cwd(), 'modules');
    this.loadedModules = new Map();
  }

  /**
   * Scan and load all modules from the modules directory
   */
  async loadAllModules(): Promise<void> {
    console.log(`[🔌 MODULE LOADER] Scanning modules directory: ${this.modulesDir}`);
    
    try {
      // Check if modules directory exists
      let directoryCreated = false;
      try {
        await fs.access(this.modulesDir);
      } catch (error) {
        console.log(`[⚠️ MODULE LOADER] Modules directory not found: ${this.modulesDir}`);
        console.log('[🔧 MODULE LOADER] Creating modules directory automatically...');
        await fs.mkdir(this.modulesDir, { recursive: true });
        directoryCreated = true;
        console.log(`[✅ MODULE LOADER] ⚠️ Modules directory was missing and auto-created: ${this.modulesDir}`);
      }

      const files = await fs.readdir(this.modulesDir);
      const moduleFiles = files.filter(file =>
        (file.endsWith('.js') || file.endsWith('.ts')) &&
        !file.startsWith('.') &&
        file !== 'index.js' &&
        file !== 'index.ts'
      );

      const existingNames = moduleFiles.map(file => path.basename(file, path.extname(file)));
      const missingModules = this.requiredModules.filter(name => !existingNames.includes(name));

      // No longer creating stub modules - core functionality handled by TypeScript routes
      if (missingModules.length > 0) {
        console.log(`[📝 MODULE LOADER] Note: ${missingModules.join(', ')} handled by TypeScript routes, not creating stubs`);
      }

      console.log(`[🔌 MODULE LOADER] Found ${moduleFiles.length} potential modules: ${moduleFiles.join(', ')}`);

      // Load each module with enhanced error handling
      for (const file of moduleFiles) {
        await this.loadModule(file);
      }

      console.log(`[✅ MODULE LOADER] Successfully loaded ${this.loadedModules.size} modules`);
      
      // Log active modules in the requested format
      if (this.loadedModules.size > 0) {
        console.log('[🔌 MODULE LOADER] Active modules:');
        for (const [name] of this.loadedModules) {
          console.log(`🔌 Loaded module: /${name}`);
        }
      }

      this.printLoadedModules();
      
      // Log fallback mode if directory was created
      if (directoryCreated) {
        console.log('[ℹ️ MODULE LOADER] System using TypeScript routes for core endpoints, modules directory for extensions only');
      }
      
    } catch (error) {
      console.error('[❌ MODULE LOADER] Critical error in module loading system:', error);
      console.log('[🔧 MODULE LOADER] Attempting graceful fallback...');
      
      // Attempt to create basic fallback state
      try {
        await fs.mkdir(this.modulesDir, { recursive: true });
        console.log('[✅ MODULE LOADER] Fallback recovery successful - server will continue with minimal functionality');
      } catch (fallbackError) {
        console.error('[💥 MODULE LOADER] Fallback recovery failed:', fallbackError);
        console.log('[⚠️ MODULE LOADER] Server will continue but module functionality may be limited');
      }
    }
  }

  /**
   * Load a specific module file
   */
  async loadModule(filename: string): Promise<void> {
    try {
      const modulePath = path.join(this.modulesDir, filename);
      const moduleName = path.basename(filename, path.extname(filename));
      
      console.log(`[🔌 MODULE LOADER] Loading module: ${moduleName} from ${filename}`);

      // Verify file exists before attempting import
      try {
        await fs.access(modulePath);
      } catch (error) {
        console.error(`[❌ MODULE LOADER] Module file not found: ${modulePath}`);
        return;
      }

      // Dynamic import of the module with enhanced error handling
      const moduleUrl = `file://${modulePath}`;
      let moduleExport;
      
      try {
        moduleExport = await import(moduleUrl);
      } catch (importError: any) {
        console.error(`[❌ MODULE LOADER] Failed to import module ${moduleName}:`, importError.message);
        console.log(`[🔧 MODULE LOADER] Attempting to load as CommonJS module...`);
        
        // Fallback for CommonJS modules
        try {
          // Use dynamic import for CommonJS modules
          const { createRequire } = await import('module');
          const require = createRequire(import.meta.url);
          moduleExport = { default: require(modulePath) };
        } catch (cjsError: any) {
          console.error(`[❌ MODULE LOADER] CommonJS fallback failed for ${moduleName}:`, cjsError.message);
          return;
        }
      }
      
      if (!moduleExport.default) {
        console.warn(`[⚠️ MODULE LOADER] Module ${moduleName} does not export a default router`);
        return;
      }

      // Register the module's routes with the app
      this.app.use('/', moduleExport.default);
      
      // Store module info
      this.loadedModules.set(moduleName, {
        filename,
        path: modulePath,
        router: moduleExport.default,
        loadedAt: new Date().toISOString()
      });

      console.log(`🔌 /${moduleName} activated`);
    } catch (error: any) {
      console.error(`[❌ MODULE LOADER] Critical error loading module ${filename}:`, error.message);
      console.log(`[🔧 MODULE LOADER] Module ${filename} will be skipped - server will continue`);
    }
  }

  /**
   * Get information about loaded modules
   */
  getLoadedModules(): LoadedModuleInfo[] {
    return Array.from(this.loadedModules.entries()).map(([name, info]) => ({
      name,
      filename: info.filename,
      loadedAt: info.loadedAt
    }));
  }

  /**
   * Print summary of loaded modules
   */
  printLoadedModules(): void {
    if (this.loadedModules.size === 0) {
      console.log('[📦 MODULE SUMMARY] No modules loaded');
      return;
    }

    console.log('[📦 MODULE SUMMARY] Loaded modules:');
    for (const [name, info] of this.loadedModules) {
      console.log(`   📋 /${name} - ${info.filename} (loaded: ${info.loadedAt})`);
    }
  }

  /**
   * Reload all modules (useful for development)
   */
  async reloadAllModules(): Promise<void> {
    console.log('[🔄 MODULE LOADER] Reloading all modules...');
    this.loadedModules.clear();
    await this.loadAllModules();
  }

  /**
   * Get module count
   */
  getModuleCount(): number {
    return this.loadedModules.size;
  }

  /**
   * Check if system is running in fallback mode
   * Note: No longer applicable since core modules are in TypeScript
   */
  isInFallbackMode(): boolean {
    return false; // Core modules now handled by TypeScript routes
  }

  /**
   * Get fallback status information
   * Note: Updated for TypeScript-first architecture
   */
  getFallbackStatus(): { inFallbackMode: boolean; stubModules: string[]; totalModules: number } {
    return {
      inFallbackMode: false, // Core modules handled by TypeScript
      stubModules: [], // No longer creating stubs
      totalModules: this.loadedModules.size
    };
  }
}

export default ModuleLoader;
