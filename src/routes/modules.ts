import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

interface ModuleDef {
  name: string;
  actions: Record<string, (payload: any) => Promise<any>>;
}

const registry: Record<string, ModuleDef> = {};
const idRegistry: Record<string, ModuleDef> = {};
const router = express.Router();

function createHandler(mod: ModuleDef) {
  return async (req: Request, res: Response) => {
    const { module, action, payload } = req.body;
    if (module !== mod.name) {
      return res.status(404).json({ error: 'Module not found' });
    }
    try {
      const result = await mod.actions[action](payload);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };
}

function registerModule(route: string, mod: ModuleDef) {
  registry[route] = mod;
  idRegistry[mod.name] = mod;
  router.post(`/${route}`, createHandler(mod));
}

router.post('/query', async (req: Request, res: Response) => {
  const { module, action, payload } = req.body;
  const mod = registry[module] || idRegistry[module];
  if (!mod) {
    return res.status(404).json({ error: 'Module not found' });
  }
  try {
    const result = await mod.actions[action](payload);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

async function loadModules() {
  const __filename = fileURLToPath(import.meta.url);
  const modulesDir = path.resolve(path.dirname(__filename), '../modules');
  const files = await fs.promises.readdir(modulesDir);
  for (const file of files) {
    const full = path.join(modulesDir, file);
    const stat = await fs.promises.stat(full);
    if (stat.isDirectory() || !file.endsWith('.js')) continue;
    const modImport = await import(pathToFileURL(full).href);
    const mod: ModuleDef = modImport.default || modImport[Object.keys(modImport)[0]];
    if (!mod || !mod.name || !mod.actions) continue;
    const route = file.replace(/\.js$/, '').replace(/^arcanos-/, '');
    registerModule(route, mod);
  }
}

await loadModules();

export default router;
