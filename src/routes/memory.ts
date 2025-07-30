import { Router, Request, Response } from 'express';
import { databaseService, SaveMemoryRequest, LoadMemoryRequest } from '../services/database';
import { fallbackMemory } from '../services/memory';
import { sendErrorResponse, sendSuccessResponse, handleCatchError } from '../utils/response';
import { arcanosLogger } from '../utils/logger';

const router = Router();
const useDatabase = !!process.env.DATABASE_URL;

// API token middleware applied in src/index.ts

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
      return sendErrorResponse(res, 400, 'memory_key is required', 
        'Example: { memory_key: "user_preference", memory_value: { theme: "dark" } }');
    }

    if (memory_value === undefined) {
      return sendErrorResponse(res, 400, 'memory_value is required (can be null)', 
        'Example: { memory_key: "user_preference", memory_value: { theme: "dark" } }');
    }

    const container_id = getContainerId(req);
    
    const saveRequest: SaveMemoryRequest = {
      memory_key,
      memory_value,
      container_id
    };

    // Log snapshot activity on every save as requested
    console.log('💾 [MEMORY-SNAPSHOT] Saving memory:', { 
      memory_key, 
      container_id, 
      value_type: typeof memory_value,
      timestamp: new Date().toISOString() 
    });

    const result = useDatabase
      ? await databaseService.saveMemory(saveRequest)
      : await fallbackMemory.storeMemory(container_id, 'default', 'context', memory_key, memory_value);
    
    arcanosLogger.memorySnapshot('Memory saved successfully', { 
      memory_key, 
      container_id, 
      success: true
    });
    
    sendSuccessResponse(res, 'Memory saved successfully', {
      ...result,
      snapshot_logged: true
    });
    
  } catch (error: any) {
    arcanosLogger.memorySnapshot('Error saving memory', { error: error.message });
    handleCatchError(res, error, 'Memory save operation');
  }
});

// GET /memory/load?key=x - Load single memory by key
router.get('/load', async (req: Request, res: Response) => {
  try {
    const memory_key = req.query.key as string;
    
    if (!memory_key) {
      return sendErrorResponse(res, 400, 'key parameter is required', 
        'Example: /memory/load?key=user_preference');
    }

    const container_id = getContainerId(req);
    
    const loadRequest: LoadMemoryRequest = {
      memory_key,
      container_id
    };

    const result = useDatabase
      ? await databaseService.loadMemory(loadRequest)
      : await fallbackMemory.getMemory(container_id, memory_key);
    
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
    
    const results = useDatabase
      ? await databaseService.loadAllMemory(container_id)
      : await fallbackMemory.getMemoriesByUser(container_id);
    
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

// GET /memory/thread/:id - Retrieve a memory thread by id
router.get('/thread/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const container_id = getContainerId(req);

    if (!id) {
      return res.status(400).json({ error: 'id parameter is required' });
    }

    const result = useDatabase
      ? await databaseService.loadMemory({ memory_key: id, container_id })
      : await fallbackMemory.getMemoryById(id);

    if (!result) {
      return res.status(404).json({ error: 'Thread not found', id });
    }

    const thread = useDatabase
      ? (result as any).memory_value
      : result;

    if (!thread || (typeof thread === 'object' && Object.keys(thread).length === 0)) {
      return res.status(404).json({ error: 'Thread not found', id });
    }

    return res.status(200).json(thread);
  } catch (error: any) {
    console.error('❌ Error loading thread:', error);
    res.status(500).json({ error: 'Failed to load thread', details: error.message });
  }
});

// DELETE /memory/clear - Clear/reset all memory for container
router.delete('/clear', async (req: Request, res: Response) => {
  try {
    const container_id = getContainerId(req);
    
    const result = useDatabase
      ? await databaseService.clearMemory(container_id)
      : await fallbackMemory.clearAll(container_id);
    
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

// GET /memory/heartbeat - Lightweight heartbeat
router.get('/heartbeat', (_req: Request, res: Response) => {
  res.json({
    service: 'arcanos-memory',
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

export default router;