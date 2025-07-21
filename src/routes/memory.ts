import { Router, Request, Response } from 'express';
import { databaseService, SaveMemoryRequest, LoadMemoryRequest } from '../services/database';

const router = Router();

// Middleware to get container_id from headers or default
const getContainerId = (req: Request): string => {
  return (req.headers['x-container-id'] as string) || 
         (req.query.container_id as string) || 
         'default';
};

// POST /memory/save - Save memory key-value pair
router.post('/save', async (req: Request, res: Response) => {
  try {
    const { memory_key, memory_value } = req.body;
    
    if (!memory_key) {
      return res.status(400).json({ 
        error: 'memory_key is required',
        example: { memory_key: 'user_preference', memory_value: { theme: 'dark' } }
      });
    }

    if (memory_value === undefined) {
      return res.status(400).json({ 
        error: 'memory_value is required (can be null)',
        example: { memory_key: 'user_preference', memory_value: { theme: 'dark' } }
      });
    }

    const container_id = getContainerId(req);
    
    const saveRequest: SaveMemoryRequest = {
      memory_key,
      memory_value,
      container_id
    };

    const result = await databaseService.saveMemory(saveRequest);
    
    res.status(200).json({
      success: true,
      message: 'Memory saved successfully',
      data: result
    });
    
  } catch (error: any) {
    console.error('❌ Error saving memory:', error);
    res.status(500).json({ 
      error: 'Failed to save memory',
      details: error.message 
    });
  }
});

// GET /memory/load?key=x - Load single memory by key
router.get('/load', async (req: Request, res: Response) => {
  try {
    const memory_key = req.query.key as string;
    
    if (!memory_key) {
      return res.status(400).json({ 
        error: 'key parameter is required',
        example: '/memory/load?key=user_preference'
      });
    }

    const container_id = getContainerId(req);
    
    const loadRequest: LoadMemoryRequest = {
      memory_key,
      container_id
    };

    const result = await databaseService.loadMemory(loadRequest);
    
    if (!result) {
      return res.status(404).json({
        success: false,
        message: 'Memory not found',
        key: memory_key,
        container_id
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Memory loaded successfully',
      data: result
    });
    
  } catch (error: any) {
    console.error('❌ Error loading memory:', error);
    res.status(500).json({ 
      error: 'Failed to load memory',
      details: error.message 
    });
  }
});

// GET /memory/all - Dump full memory space for container
router.get('/all', async (req: Request, res: Response) => {
  try {
    const container_id = getContainerId(req);
    
    const results = await databaseService.loadAllMemory(container_id);
    
    res.status(200).json({
      success: true,
      message: 'All memory loaded successfully',
      container_id,
      count: results.length,
      data: results
    });
    
  } catch (error: any) {
    console.error('❌ Error loading all memory:', error);
    res.status(500).json({ 
      error: 'Failed to load all memory',
      details: error.message 
    });
  }
});

// DELETE /memory/clear - Clear/reset all memory for container
router.delete('/clear', async (req: Request, res: Response) => {
  try {
    const container_id = getContainerId(req);
    
    const result = await databaseService.clearMemory(container_id);
    
    res.status(200).json({
      success: true,
      message: 'Memory cleared successfully',
      container_id,
      cleared_count: result.cleared
    });
    
  } catch (error: any) {
    console.error('❌ Error clearing memory:', error);
    res.status(500).json({ 
      error: 'Failed to clear memory',
      details: error.message 
    });
  }
});

// GET /memory/health - Health check for memory service
router.get('/health', async (req: Request, res: Response) => {
  try {
    const health = await databaseService.healthCheck();
    
    const statusCode = health.status === 'healthy' ? 200 : 
                      health.status === 'degraded' ? 200 : 503;
    
    res.status(statusCode).json({
      service: 'arcanos-memory',
      ...health
    });
    
  } catch (error: any) {
    console.error('❌ Memory health check failed:', error);
    res.status(503).json({
      service: 'arcanos-memory',
      status: 'unhealthy',
      database: false,
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

export default router;