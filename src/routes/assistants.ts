import express from 'express';
import { openAIAssistantsService } from '../services/openai-assistants.js';

const router = express.Router();

/**
 * GET /assistants - Get all synced assistants
 */
router.get('/assistants', async (_req, res) => {
  try {
    const assistants = await openAIAssistantsService.loadAssistants();
    const assistantNames = Object.keys(assistants);
    
    res.json({
      success: true,
      count: assistantNames.length,
      assistants: assistants,
      assistantNames: assistantNames,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /assistants/sync - Manually trigger assistant sync
 */
router.post('/assistants/sync', async (_req, res) => {
  try {
    console.log('[API] Manual assistant sync triggered');
    const assistants = await openAIAssistantsService.syncAssistants();
    const assistantNames = Object.keys(assistants);
    
    res.json({
      success: true,
      message: 'Assistant sync completed successfully',
      count: assistantNames.length,
      assistantNames: assistantNames,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('[API] Assistant sync failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /assistants/:name - Get specific assistant by normalized name
 */
router.get('/assistants/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const assistant = await openAIAssistantsService.getAssistant(name.toUpperCase());
    
    if (assistant) {
      res.json({
        success: true,
        assistant: assistant,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Assistant not found',
        availableNames: await openAIAssistantsService.getAssistantNames(),
        timestamp: new Date().toISOString()
      });
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;