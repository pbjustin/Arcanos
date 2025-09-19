import express, { Request, Response } from 'express';
import { loadModuleDefinitions, ModuleDef } from '../modules/moduleLoader.js';

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
  registry[mod.name] = mod;
  router.post(`/modules/${route}`, createHandler(mod));
}

const loadedModules = await loadModuleDefinitions();
for (const { route, definition } of loadedModules) {
  registerModule(route, definition);
}

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
