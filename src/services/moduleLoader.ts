import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { resolveErrorMessage } from "@core/lib/errors/index.js";

export interface ModuleDef {
  name: string;
  description?: string;
  actions: Record<string, (payload: unknown) => Promise<unknown>>;
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
  //audit Assumption: only .ts/.js module files should load
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
    } catch (err: unknown) {
      //audit Assumption: module load failure should not halt loading
      console.error(`Failed to load module ${file.name}:`, resolveErrorMessage(err));
    }
  }

  cachedModules = loaded;
  return loaded;
}

export function clearModuleDefinitionCache() {
  cachedModules = null;
}
