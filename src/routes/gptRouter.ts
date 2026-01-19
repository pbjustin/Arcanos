import express from 'express';
import modulesRouter from './modules.js';
import gptModuleMapPromise from '../config/gptRouterConfig.js';

const router = express.Router();

// Forward any request under /gpt/:gptId to the appropriate module route
router.use('/:gptId', async (req, res, next) => {
  try {
    const gptModuleMap = await gptModuleMapPromise;
    const entry = gptModuleMap[req.params.gptId];
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
