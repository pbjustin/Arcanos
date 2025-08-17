/**
 * System Status Routes
 * Provides endpoints for reading and updating system state
 */

import express, { Request, Response } from 'express';
import { loadState, updateState, SystemState } from '../services/stateManager.js';
import { confirmGate } from '../middleware/confirmGate.js';

const router = express.Router();

/**
 * GET /status - Retrieve current system state
 */
router.get('/status', (_: Request, res: Response) => {
  try {
    const state = loadState();
    res.json(state);
  } catch (error) {
    console.error('[STATUS] Error retrieving system state:', error);
    res.status(500).json({
      error: 'Failed to retrieve system state',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /status - Update system state
 */
router.post('/status', confirmGate, (req: Request, res: Response) => {
  try {
    const updates: Partial<SystemState> = req.body;
    
    // Validate that we have some data to update
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        error: 'No update data provided',
        message: 'Request body must contain state updates'
      });
    }
    
    const updatedState = updateState(updates);
    console.log('[STATUS] System state updated:', Object.keys(updates));
    
    res.json(updatedState);
  } catch (error) {
    console.error('[STATUS] Error updating system state:', error);
    res.status(500).json({
      error: 'Failed to update system state',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;