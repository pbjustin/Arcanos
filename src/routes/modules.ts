import express, { Request, Response } from 'express';
import { loadModuleDefinitions, ModuleDef } from '../modules/moduleLoader.js';

const router = express.Router();

const registryByRoute = new Map<string, ModuleDef>();
const registryByName = new Map<string, ModuleDef>();
const moduleRoutes = new Map<string, string>();

function createHandler(mod: ModuleDef) {
  return async (req: Request, res: Response) => {
    const { module, action, payload } = req.body as {
      module?: string;
      action?: string;
      payload?: unknown;
    };
    if (module !== mod.name) {
      return res.status(404).json({ error: 'Module not found' });
    }
    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }
    const handler = mod.actions[action];
    if (!handler) {
      return res.status(404).json({ error: 'Action not found' });
    }
    try {
      const result = await handler(payload);
      res.json(result);
    } catch (err: unknown) {
      //audit Assumption: module failures should return 500
      res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
    }
  };
}

export function registerModule(route: string, mod: ModuleDef) {
  registryByRoute.set(route, mod);
  registryByName.set(mod.name, mod);
  moduleRoutes.set(mod.name, route);
  router.post(`/modules/${route}`, createHandler(mod));
}

const loadedModules = await loadModuleDefinitions();
for (const { route, definition } of loadedModules) {
  registerModule(route, definition);
}

router.get('/registry', (_req: Request, res: Response) => {
  const modules = Array.from(registryByName.values()).map((mod) => ({
    name: mod.name,
    description: mod.description ?? null,
    route: moduleRoutes.get(mod.name) ?? null,
    actions: Object.keys(mod.actions),
    gptIds: mod.gptIds ?? []
  }));

  res.json({
    count: modules.length,
    modules
  });
});

router.get('/registry/:moduleName', (req: Request, res: Response) => {
  const identifier = req.params.moduleName;
  let mod = registryByName.get(identifier);
  let route = moduleRoutes.get(identifier) ?? null;

  if (!mod) {
    mod = registryByRoute.get(identifier);
    if (mod) {
      route = moduleRoutes.get(mod.name) ?? identifier;
    }
  }

  if (!mod) {
    return res.json({ exists: false, module: null });
  }

  return res.json({
    exists: true,
    module: {
      name: mod.name,
      description: mod.description ?? null,
      route,
      actions: Object.keys(mod.actions),
      gptIds: mod.gptIds ?? []
    }
  });
});

router.post('/queryroute', async (req: Request, res: Response) => {
  const { module: moduleName, action, payload } = req.body as {
    module?: string;
    action?: string;
    payload?: unknown;
  };
  if (!moduleName) {
    return res.status(400).json({ error: 'Module name is required' });
  }
  const mod = registryByName.get(moduleName) ?? registryByRoute.get(moduleName);
  if (!mod) {
    return res.status(404).json({ error: 'Module not found' });
  }
  if (!action) {
    return res.status(400).json({ error: 'Action is required' });
  }
  const handler = mod.actions[action];
  if (!handler) {
    return res.status(404).json({ error: 'Action not found' });
  }
  try {
    const result = await handler(payload);
    res.json(result);
  } catch (err: unknown) {
    //audit Assumption: module failures should return 500
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

export default router;
