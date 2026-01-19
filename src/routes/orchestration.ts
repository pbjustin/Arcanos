/**
 * Orchestration Shell API Routes
 * Provides endpoints for GPT-5.1 orchestration shell management
 */

import express, { Request, Response } from 'express';
import { resetOrchestrationShell, getOrchestrationShellStatus } from '../services/orchestrationShell.js';
import { handleAIError } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from '../types/dto.js';

const router = express.Router();

type OrchestrationRequest = AIRequestDTO & {
  action?: 'reset' | 'status';
  agentId?: string;
  contextSnapshotTag?: string;
};

interface OrchestrationResponse extends AIResponseDTO {
  routingStages?: string[];
  gpt5Used?: boolean;
  auditSafe?: {
    mode: boolean;
    overrideUsed: boolean;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext?: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage?: {
    requestId: string;
    logged: boolean;
  };
  orchestration?: {
    success: boolean;
    message: string;
    meta?: {
      timestamp: string;
      stages: string[];
      gpt5Model: string;
      safeguardsApplied: boolean;
    };
    logs?: string[];
    status?: {
      active: boolean;
      model: string;
      lastReset?: string;
      memoryEntries: number;
    };
  };
}

/**
 * POST /orchestration/reset - Reset GPT-5.1 orchestration shell
 * Performs purge and redeploy sequence with safeguards
 */
router.post('/orchestration/reset', confirmGate, async (
  req: Request<{}, OrchestrationResponse | ErrorResponseDTO, OrchestrationRequest>,
  res: Response<OrchestrationResponse | ErrorResponseDTO>
) => {
  try {
    console.log('🔄 [ORCHESTRATION] Reset request received');

    const { agentId, sessionId, contextSnapshotTag } = req.body;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'Missing agentId or sessionId' });
      return;
    }

    // Execute orchestration shell reset
    const result = await resetOrchestrationShell({
      agentId,
      sessionId,
      contextSnapshotTag
    });
    
    const response: OrchestrationResponse = {
      result: result.message,
      module: 'OrchestrationShell',
      meta: {
        tokens: undefined, // No token usage for orchestration commands
        id: `orchestration_${Date.now()}`,
        created: Math.floor(Date.now() / 1000)
      },
      activeModel: result.meta.gpt5Model,
      fallbackFlag: false,
      gpt5Used: true,
      routingStages: ['ORCHESTRATION_RESET', ...result.meta.stages],
      auditSafe: {
        mode: true,
        overrideUsed: false,
        auditFlags: ['ORCHESTRATION', 'SYSTEM_RESET'],
        processedSafely: result.success
      },
      memoryContext: {
        entriesAccessed: 0,
        contextSummary: 'Orchestration reset - memory context cleared',
        memoryEnhanced: false
      },
      taskLineage: {
        requestId: `orchestration_reset_${Date.now()}`,
        logged: true
      },
      orchestration: {
        success: result.success,
        message: result.message,
        meta: result.meta,
        logs: result.logs
      }
    };

    if (result.success) {
      res.status(200).json(response);
    } else {
      res.status(500).json({
        ...response,
        error: result.message
      });
    }

  } catch (error: any) {
    console.error('❌ [ORCHESTRATION] Reset failed:', error);
    handleAIError(error, 'orchestration reset request', 'orchestration-reset', res);
  }
});

/**
 * GET /orchestration/status - Get orchestration shell status
 * Returns current status and configuration
 */
router.get('/orchestration/status', async (
  _: Request,
  res: Response<OrchestrationResponse | ErrorResponseDTO>
) => {
  try {
    console.log('📊 [ORCHESTRATION] Status request received');
    
    // Get orchestration shell status
    const status = await getOrchestrationShellStatus();
    
    const response: OrchestrationResponse = {
      result: status.active ? 'Orchestration shell is active' : 'Orchestration shell is inactive',
      module: 'OrchestrationShell',
      meta: {
        tokens: undefined,
        id: `orchestration_status_${Date.now()}`,
        created: Math.floor(Date.now() / 1000)
      },
      activeModel: status.model,
      fallbackFlag: false,
      gpt5Used: false, // Status check doesn't use GPT-5.1
      routingStages: ['ORCHESTRATION_STATUS'],
      auditSafe: {
        mode: true,
        overrideUsed: false,
        auditFlags: ['ORCHESTRATION', 'STATUS_CHECK'],
        processedSafely: true
      },
      memoryContext: {
        entriesAccessed: status.memoryEntries,
        contextSummary: `Orchestration memory entries: ${status.memoryEntries}`,
        memoryEnhanced: false
      },
      taskLineage: {
        requestId: `orchestration_status_${Date.now()}`,
        logged: true
      },
      orchestration: {
        success: true,
        message: 'Status retrieved successfully',
        status
      }
    };

    res.status(200).json(response);

  } catch (error: any) {
    console.error('❌ [ORCHESTRATION] Status check failed:', error);
    handleAIError(error, 'orchestration status request', 'orchestration-status', res);
  }
});

/**
 * POST /orchestration/purge - Legacy endpoint for the exact script from problem statement
 * Executes the exact orchestration reset functionality as specified
 */
router.post('/orchestration/purge', confirmGate, async (
  req: Request<{}, OrchestrationResponse | ErrorResponseDTO, OrchestrationRequest>,
  res: Response<OrchestrationResponse | ErrorResponseDTO>
) => {
  // This endpoint provides the exact same functionality as /reset
  // but with the specific naming from the problem statement
  try {
    console.log('🔄 [ORCHESTRATION] Purge + Redeploy request received');

    const { agentId, sessionId, contextSnapshotTag } = req.body;
    if (!agentId || !sessionId) {
      res.status(400).json({ error: 'Missing agentId or sessionId' });
      return;
    }

    const result = await resetOrchestrationShell({
      agentId,
      sessionId,
      contextSnapshotTag
    });
    
    const response: OrchestrationResponse = {
      result: "GPT-5.1 orchestration shell has been purged and redeployed.",
      module: 'OrchestrationShell',
      meta: {
        tokens: undefined,
        id: `orchestration_purge_${Date.now()}`,
        created: Math.floor(Date.now() / 1000)
      },
      activeModel: result.meta.gpt5Model,
      fallbackFlag: false,
      gpt5Used: true,
      routingStages: ['ORCHESTRATION_PURGE', ...result.meta.stages],
      auditSafe: {
        mode: true,
        overrideUsed: false,
        auditFlags: ['ORCHESTRATION', 'PURGE_REDEPLOY'],
        processedSafely: result.success
      },
      memoryContext: {
        entriesAccessed: 0,
        contextSummary: 'Orchestration purge - memory context cleared',
        memoryEnhanced: false
      },
      taskLineage: {
        requestId: `orchestration_purge_${Date.now()}`,
        logged: true
      },
      orchestration: {
        success: result.success,
        message: "✅ GPT-5.1 orchestration shell has been purged and redeployed.",
        meta: result.meta,
        logs: result.logs
      }
    };

    if (result.success) {
      res.status(200).json(response);
    } else {
      res.status(500).json({
        ...response,
        error: result.message
      });
    }

  } catch (error: any) {
    console.error('❌ [ORCHESTRATION] Purge failed:', error);
    handleAIError(error, 'orchestration purge request', 'orchestration-purge', res);
  }
});

export default router;