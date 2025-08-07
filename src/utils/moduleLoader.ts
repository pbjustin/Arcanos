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
  private requiredModules: string[] = ['write', 'guide', 'audit', 'sim', 'track'];

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

      // Create stub modules for missing required modules
      if (missingModules.length > 0) {
        console.log(`[🧩 MODULE LOADER] Creating stub modules for: ${missingModules.join(', ')}`);
        for (const mod of missingModules) {
          await this.createStubModule(mod);
          moduleFiles.push(`${mod}.js`);
        }
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
      
      // Log fallback mode if directory was created or only stubs exist
      if (directoryCreated || missingModules.length === this.requiredModules.length) {
        console.log('[⚠️ MODULE LOADER] System is running in fallback-safe mode with stub modules');
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

  private async createStubModule(name: string): Promise<void> {
    const stubPath = path.join(this.modulesDir, `${name}.js`);
    const template = `import express from 'express';

const router = express.Router();

// ${name} module stub - auto-generated fallback
router.get("/", (req, res) => res.send("🧠 /${name} route active"));

router.post('/${name}', async (req, res) => {
  res.json({
    status: 'stub',
    message: '${name} module stub response',
    data: req.body || {},
    timestamp: new Date().toISOString()
  });
});

router.get('/${name}/status', (req, res) => {
  res.json({
    module: '${name}',
    status: 'stub',
    version: '0.0.1',
    endpoints: ['/', '/${name}', '/${name}/status'],
    note: 'Auto-generated fallback module'
  });
});

export default router;\n`;

    await fs.writeFile(stubPath, template, 'utf8');
    console.log(`[🧩 MODULE LOADER] Created stub for missing module: ${name}`);
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
   */
  isInFallbackMode(): boolean {
    // Check if all loaded modules are newly created stubs
    const moduleNames = Array.from(this.loadedModules.keys());
    const stubModuleCount = moduleNames.filter(name => 
      this.requiredModules.includes(name)
    ).length;
    
    return stubModuleCount === this.loadedModules.size && this.loadedModules.size > 0;
  }

  /**
   * Get fallback status information
   */
  getFallbackStatus(): { inFallbackMode: boolean; stubModules: string[]; totalModules: number } {
    const moduleNames = Array.from(this.loadedModules.keys());
    const stubModules = moduleNames.filter(name => this.requiredModules.includes(name));
    
    return {
      inFallbackMode: this.isInFallbackMode(),
      stubModules,
      totalModules: this.loadedModules.size
    };
  }
}

export default ModuleLoader;
