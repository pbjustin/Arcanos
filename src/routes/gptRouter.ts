import express from 'express';
import modulesRouter from './modules.js';
import gptModuleMap from '../config/gptRouterConfig.js';

const router = express.Router();

// Forward any request under /gpt/:gptId to the appropriate module route
router.use('/:gptId', (req, res, next) => {
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
});

export default router;
