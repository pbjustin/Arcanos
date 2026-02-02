import express from 'express';
import modulesRouter from './modules.js';
import getGptModuleMap from '../config/gptRouterConfig.js';

const router = express.Router();

// Forward any request under /gpt/:gptId to the appropriate module route
router.use('/:gptId', async (req, res, next) => {
  try {
    const gptModuleMap = await getGptModuleMap();
    const incomingGptId = req.params.gptId;
    const configuredGptIds = Object.keys(gptModuleMap);

    const matchedId = configuredGptIds.find(id => incomingGptId.includes(id));
    const entry = matchedId ? gptModuleMap[matchedId] : undefined;

    if (!entry) {
      return res.status(404).json({ error: 'Unknown GPTID' });
    }

    // Ensure body exists so downstream handlers can attach module metadata
    if (!req.body) {
      req.body = {};
    }

    req.url = `/modules/${entry.route}`;
    req.body.module = entry.module;
    return modulesRouter(req, res, next);
  } catch (err) {
    return next(err);
  }
});

export default router;
