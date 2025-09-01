import express, { Request, Response } from 'express';
import ArcanosTutor from '../modules/arcanos-tutor.js';
import ArcanosGaming from '../modules/arcanos-gaming.js';

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
  router.post(`/${route}`, createHandler(mod));
}

registerModule('tutor', ArcanosTutor);
registerModule('gaming', ArcanosGaming);

export default router;
