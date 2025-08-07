import fs from 'fs';
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
  private modulesPath: string;
  private loadedModules: Map<string, ModuleInfo>;

  constructor(app: Express, modulesPath: string | null = null) {
    this.app = app;
    this.modulesPath = modulesPath || path.join(process.cwd(), 'modules');
    this.loadedModules = new Map();
  }

  /**
   * Scan and load all modules from the modules directory
   */
  async loadAllModules(): Promise<void> {
    console.log(`[🔌 MODULE LOADER] Scanning modules directory: ${this.modulesPath}`);
    
    if (!fs.existsSync(this.modulesPath)) {
      console.log(`[⚠️  MODULE LOADER] Modules directory not found: ${this.modulesPath}`);
      return;
    }

    try {
      const files = fs.readdirSync(this.modulesPath);
      const moduleFiles = files.filter(file => 
        (file.endsWith('.js') || file.endsWith('.ts')) && 
        !file.startsWith('.') &&
        file !== 'index.js' &&
        file !== 'index.ts'
      );

      console.log(`[🔌 MODULE LOADER] Found ${moduleFiles.length} potential modules: ${moduleFiles.join(', ')}`);

      for (const file of moduleFiles) {
        await this.loadModule(file);
      }

      console.log(`[✅ MODULE LOADER] Successfully loaded ${this.loadedModules.size} modules`);
      this.printLoadedModules();
    } catch (error) {
      console.error('[❌ MODULE LOADER] Error scanning modules directory:', error);
    }
  }

  /**
   * Load a specific module file
   */
  async loadModule(filename: string): Promise<void> {
    try {
      const modulePath = path.join(this.modulesPath, filename);
      const moduleName = path.basename(filename, path.extname(filename));
      
      console.log(`[🔌 MODULE LOADER] Loading module: ${moduleName} from ${filename}`);

      // Dynamic import of the module
      const moduleUrl = `file://${modulePath}`;
      const moduleExport = await import(moduleUrl);
      
      if (!moduleExport.default) {
        console.warn(`[⚠️  MODULE LOADER] Module ${moduleName} does not export a default router`);
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
      console.error(`[❌ MODULE LOADER] Failed to load module ${filename}:`, error.message);
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
}

export default ModuleLoader;