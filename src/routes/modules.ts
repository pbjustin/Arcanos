import express, { Request, Response } from 'express';
import { loadModuleDefinitions, ModuleDef } from '../modules/moduleLoader.js';
import { resolveErrorMessage } from '../lib/errors/index.js';

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
      res.status(500).json({ error: resolveErrorMessage(err) });
    }
  };
}

/**
 * Purpose: Register a module definition and mount its handler route.
 * Inputs/Outputs: route string and ModuleDef; mounts handler and caches module metadata.
 * Edge cases: Overwrites existing module entries with the same route or name.
 */
export function registerModule(route: string, mod: ModuleDef) {
  registryByRoute.set(route, mod);
  registryByName.set(mod.name, mod);
  moduleRoutes.set(mod.name, route);
  router.post(`/modules/${route}`, createHandler(mod));
}

/**
 * Purpose: Build a safe module registry snapshot for daemon prompts.
 * Inputs/Outputs: None; returns list of module metadata without gptIds.
 * Edge cases: Returns empty list when no modules are loaded.
 */
export function getModulesForRegistry(): Array<{
  id: string;
  description: string | null;
  route: string | null;
  actions: string[];
}> {
  //audit Assumption: registryByName holds current modules; risk: stale data; invariant: map values used; handling: map to safe shape.
  return Array.from(registryByName.values()).map(mod => ({
    id: mod.name,
    description: mod.description ?? null,
    route: moduleRoutes.get(mod.name) ?? null,
    actions: Object.keys(mod.actions)
  }));
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
    res.status(500).json({ error: resolveErrorMessage(err) });
  }
});

export default router;
