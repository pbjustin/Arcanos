import { Router } from 'express';
import { getAssistant, getAssistantRegistry, syncAssistantRegistry } from '../services/openai-assistants.js';

const router = Router();

router.get('/', async (_req, res) => {
  const registry = await getAssistantRegistry();
  const assistantNames = Object.keys(registry);
  res.json({
    success: true,
    count: assistantNames.length,
    assistants: registry,
    assistantNames,
    timestamp: new Date().toISOString()
  });
});

router.post('/sync', async (_req, res) => {
  try {
    const registry = await syncAssistantRegistry();
    const assistantNames = Object.keys(registry);
    res.json({
      success: true,
      message: 'Assistant sync completed successfully',
      count: assistantNames.length,
      assistantNames,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to sync assistants',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
});

router.get('/:name', async (req, res) => {
  const requestedName = req.params.name;

  const assistant = await getAssistant(requestedName);

  if (!assistant) {
    res.status(404).json({
      success: false,
      message: `Assistant ${requestedName} not found`,
      timestamp: new Date().toISOString()
    });
    return;
  }

  res.json({
    success: true,
    assistant,
    timestamp: new Date().toISOString()
  });
});

export default router;
