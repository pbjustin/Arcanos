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
      await fs.mkdir(this.modulesDir, { recursive: true });

      const files = await fs.readdir(this.modulesDir);
      const moduleFiles = files.filter(file =>
        (file.endsWith('.js') || file.endsWith('.ts')) &&
        !file.startsWith('.') &&
        file !== 'index.js' &&
        file !== 'index.ts'
      );

      const existingNames = moduleFiles.map(file => path.basename(file, path.extname(file)));
      const missingModules = this.requiredModules.filter(name => !existingNames.includes(name));

      for (const mod of missingModules) {
        await this.createStubModule(mod);
        moduleFiles.push(`${mod}.js`);
      }

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

  private async createStubModule(name: string): Promise<void> {
    const stubPath = path.join(this.modulesDir, `${name}.js`);
    const template = `import express from 'express';

const router = express.Router();

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
    endpoints: ['/${name}', '/${name}/status']
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
