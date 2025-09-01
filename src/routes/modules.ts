import express, { Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

interface ModuleDef {
  name: string;
  actions: Record<string, (payload: any) => Promise<any>>;
}

const registry: Record<string, ModuleDef> = {};
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

export function registerModule(route: string, mod: ModuleDef) {
  registry[route] = mod;
  router.post(`/modules/${route}`, createHandler(mod));
}

async function loadModules() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const modulesDir = path.resolve(__dirname, '../modules');
  const files = await fs.readdir(modulesDir, { withFileTypes: true });

  for (const file of files) {
    if (!file.isFile()) continue;
    if (!file.name.endsWith('.js') && !file.name.endsWith('.ts')) continue;

    const route = file.name
      .replace(/\.(ts|js)$/i, '')
      .replace(/^arcanos-/, '');

    const moduleUrl = pathToFileURL(path.join(modulesDir, file.name)).href;
    try {
      const mod: ModuleDef = (await import(moduleUrl)).default;
      if (mod && mod.actions) {
        registerModule(route, mod);
      }
    } catch (err) {
      console.error(`Failed to load module ${file.name}:`, err);
    }
  }
}

await loadModules();

router.post('/queryroute', async (req: Request, res: Response) => {
  const { module: moduleName, action, payload } = req.body;
  const mod = registry[moduleName];
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

export default router;
