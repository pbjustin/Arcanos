import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export interface ModuleDef {
  name: string;
  description?: string;
  actions: Record<string, (payload: any) => Promise<any>>;
  gptIds?: string[];
}

export interface LoadedModule {
  route: string;
  definition: ModuleDef;
}

let cachedModules: LoadedModule[] | null = null;

function normalizeRouteFromFilename(fileName: string): string {
  return fileName.replace(/\.(ts|js)$/i, '').replace(/^arcanos-/, '');
}

function shouldIncludeFile(fileName: string): boolean {
  if (!/\.(ts|js)$/i.test(fileName)) return false;
  if (/\.d\.ts$/i.test(fileName)) return false;
  if (/moduleLoader\.(ts|js)$/i.test(fileName)) return false;
  return true;
}

export async function loadModuleDefinitions(): Promise<LoadedModule[]> {
  if (cachedModules) {
    return cachedModules;
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const modulesDir = __dirname;
  const files = await fs.readdir(modulesDir, { withFileTypes: true });

  const loaded: LoadedModule[] = [];

  for (const file of files) {
    if (!file.isFile()) continue;
    if (!shouldIncludeFile(file.name)) continue;

    const route = normalizeRouteFromFilename(file.name);
    const moduleUrl = pathToFileURL(path.join(modulesDir, file.name)).href;

    try {
      const imported = await import(moduleUrl);
      const mod: ModuleDef | undefined = imported.default;
      if (mod && mod.actions) {
        loaded.push({ route, definition: mod });
      }
    } catch (err) {
      console.error(`Failed to load module ${file.name}:`, err);
    }
  }

  cachedModules = loaded;
  return loaded;
}

export function clearModuleDefinitionCache() {
  cachedModules = null;
}
