import { sendBadRequest, sendInternalErrorPayload } from '@shared/http/index.js';
/**
 * Orchestration Shell API Routes
 * Provides endpoints for GPT-5.1 orchestration shell management
 */

import express, { Request, Response } from 'express';
import { resetOrchestrationShell, getOrchestrationShellStatus } from "@services/orchestrationShell.js";
import { confirmGate } from "@transport/http/middleware/confirmGate.js";
import type { AIRequestDTO, AIResponseDTO, ErrorResponseDTO } from "@shared/types/dto.js";
import {
  legacyOperatorHttpBoundary,
} from '@services/controlPlane/legacyOperatorHttpBoundary.js';
import {
  legacyOperatorBodyParser,
} from '@services/controlPlane/legacyOperatorBodyParser.js';

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

interface ValidatedOrchestrationResetRequest {
  agentId: string;
  sessionId: string;
  contextSnapshotTag?: string;
}

function readBoundedOrchestrationText(
  value: unknown,
  maxLength: number
): string | null {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function validateOrchestrationResetRequest(
  body: unknown
): ValidatedOrchestrationResetRequest | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const agentId = readBoundedOrchestrationText(record.agentId, 128);
  const sessionId = readBoundedOrchestrationText(record.sessionId, 256);
  const contextSnapshotTag = record.contextSnapshotTag === undefined
    ? undefined
    : readBoundedOrchestrationText(record.contextSnapshotTag, 256);
  if (!agentId || !sessionId || contextSnapshotTag === null) {
    return null;
  }
  return {
    agentId,
    sessionId,
    ...(contextSnapshotTag ? { contextSnapshotTag } : {}),
  };
}

/**
 * POST /orchestration/reset - Reset GPT-5.1 orchestration shell
 * Performs purge and redeploy sequence with safeguards
 */
router.post(
  '/orchestration/reset',
  legacyOperatorHttpBoundary,
  legacyOperatorBodyParser,
  confirmGate,
  async (
    req: Request<{}, OrchestrationResponse | ErrorResponseDTO, OrchestrationRequest>,
    res: Response<OrchestrationResponse | ErrorResponseDTO>
  ) => {
    try {
      const validatedRequest = validateOrchestrationResetRequest(req.body);
      if (!validatedRequest) {
        sendBadRequest(res, 'Invalid orchestration request');
        return;
      }
      const { agentId, sessionId, contextSnapshotTag } = validatedRequest;
      req.logger?.info?.('orchestration.reset.started', {
        requestId: req.requestId,
        principalId: req.controlPlanePrincipal?.principalId,
      });

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
        req.logger?.error?.('orchestration.reset.failed', {
          requestId: req.requestId,
        });
        sendInternalErrorPayload(res, {
          error: 'Orchestration reset failed',
        });
      }
    } catch {
      req.logger?.error?.('orchestration.reset.failed', {
        requestId: req.requestId,
      });
      sendInternalErrorPayload(res, {
        error: 'Orchestration reset failed',
      });
    }
  }
);

/**
 * GET /orchestration/status - Get orchestration shell status
 * Returns current status and configuration
 */
router.get('/orchestration/status', legacyOperatorHttpBoundary, async (
  req: Request,
  res: Response<OrchestrationResponse | ErrorResponseDTO>
) => {
  try {
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

  } catch {
    req.logger?.error?.('orchestration.status.failed', {
      requestId: req.requestId,
    });
    sendInternalErrorPayload(res, {
      error: 'Orchestration status retrieval failed',
    });
  }
});

/**
 * POST /orchestration/purge - Legacy endpoint for the exact script from problem statement
 * Executes the exact orchestration reset functionality as specified
 */
router.post(
  '/orchestration/purge',
  legacyOperatorHttpBoundary,
  legacyOperatorBodyParser,
  confirmGate,
  async (
    req: Request<{}, OrchestrationResponse | ErrorResponseDTO, OrchestrationRequest>,
    res: Response<OrchestrationResponse | ErrorResponseDTO>
  ) => {
    // This endpoint provides the exact same functionality as /reset
    // but with the specific naming from the problem statement
    try {
      const validatedRequest = validateOrchestrationResetRequest(req.body);
      if (!validatedRequest) {
        sendBadRequest(res, 'Invalid orchestration request');
        return;
      }
      const { agentId, sessionId, contextSnapshotTag } = validatedRequest;
      req.logger?.info?.('orchestration.purge.started', {
        requestId: req.requestId,
        principalId: req.controlPlanePrincipal?.principalId,
      });

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
        req.logger?.error?.('orchestration.purge.failed', {
          requestId: req.requestId,
        });
        sendInternalErrorPayload(res, {
          error: 'Orchestration purge failed',
        });
      }
    } catch {
      req.logger?.error?.('orchestration.purge.failed', {
        requestId: req.requestId,
      });
      sendInternalErrorPayload(res, {
        error: 'Orchestration purge failed',
      });
    }
  }
);

export default router;
