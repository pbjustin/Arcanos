import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import {
  AssistantRegistrySyncInProgressError,
  getAssistant,
  getAssistantNames,
  syncAssistantRegistry,
} from '@services/openai-assistants.js';
import {
  assistantRegistryBodyParser,
} from '@services/controlPlane/assistantRegistryBodyParser.js';
import {
  buildAssistantRegistryConfirmationBinding,
  buildAssistantRegistrySyncConfirmationIntent,
} from '@services/controlPlane/assistantRegistryConfirmation.js';
import {
  assistantRegistryHttpBoundary,
} from '@services/controlPlane/assistantRegistryHttpBoundary.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';

const router = Router();

router.use(assistantRegistryHttpBoundary, assistantRegistryBodyParser);

function canWriteAssistantRegistryResponse(res: Response): boolean {
  return !res.headersSent && !res.writableEnded;
}

function logAssistantRegistryFailure(
  req: Request,
  event: string,
  failureCode: string
): void {
  try {
    req.logger?.error?.(event, {
      requestId: req.requestId,
      traceId: req.traceId,
      failureCode,
    });
  } catch {
    // Logging must never prevent the fixed public failure from completing.
  }
}

function requireAssistantRegistrySyncConfirmation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const principalId = req.controlPlanePrincipal?.principalId;
  if (!principalId) {
    res.status(403).json({
      ok: false,
      error: {
        code: 'CONTROL_PLANE_FORBIDDEN',
        message: 'Control-plane operation is not permitted.',
      },
    });
    return;
  }

  let confirmationAccepted = false;
  confirmGate(req, res, () => {
    confirmationAccepted = true;
  }, {
    challengeBinding: buildAssistantRegistryConfirmationBinding(
      req,
      principalId
    ),
    requestFingerprintBody: buildAssistantRegistrySyncConfirmationIntent(),
    requireChallengeToken: true,
  });
  if (!confirmationAccepted) {
    return;
  }
  if (req.confirmationContext?.usedChallengeToken !== true) {
    res.status(403).json({
      ok: false,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: 'Assistant registry sync requires a consumed confirmation challenge.',
      },
    });
    return;
  }
  next();
}

function sendAssistantRegistryUnavailable(
  req: Request,
  res: Response
): void {
  logAssistantRegistryFailure(
    req,
    'assistant_registry.read_failed',
    'registry_unavailable'
  );
  if (!canWriteAssistantRegistryResponse(res)) {
    return;
  }
  res.status(503).json({
    ok: false,
    error: {
      code: 'ASSISTANT_REGISTRY_UNAVAILABLE',
      message: 'Assistant registry is unavailable.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

router.get('/', async (req, res) => {
  try {
    const names = (await getAssistantNames()).sort();
    res.json({
      ok: true,
      count: names.length,
      names,
    });
  } catch {
    sendAssistantRegistryUnavailable(req, res);
  }
});

router.post(
  '/sync',
  requireAssistantRegistrySyncConfirmation,
  async (req, res) => {
    try {
      const result = await syncAssistantRegistry();
      res.json({
        ok: true,
        changed: result.changed,
        count: Object.keys(result.registry).length,
      });
    } catch (error) {
      if (error instanceof AssistantRegistrySyncInProgressError) {
        if (!canWriteAssistantRegistryResponse(res)) {
          return;
        }
        res.setHeader('Retry-After', '5');
        res.status(409).json({
          ok: false,
          error: {
            code: 'ASSISTANT_REGISTRY_SYNC_IN_PROGRESS',
            message: 'An assistant registry synchronization is already running.',
          },
          ...(req.requestId ? { requestId: req.requestId } : {}),
        });
        return;
      }
      logAssistantRegistryFailure(
        req,
        'assistant_registry.sync_failed',
        'assistant_registry_sync_failed'
      );
      if (!canWriteAssistantRegistryResponse(res)) {
        return;
      }
      res.status(502).json({
        ok: false,
        error: {
          code: 'ASSISTANT_REGISTRY_SYNC_FAILED',
          message: 'Assistant registry synchronization failed.',
        },
        ...(req.requestId ? { requestId: req.requestId } : {}),
      });
    }
  }
);

router.get('/:name', async (req, res) => {
  try {
    const assistant = await getAssistant(req.params.name);
    if (!assistant) {
      res.status(404).json({
        ok: false,
        error: {
          code: 'ASSISTANT_NOT_FOUND',
          message: 'Assistant was not found.',
        },
        ...(req.requestId ? { requestId: req.requestId } : {}),
      });
      return;
    }

    res.json({
      ok: true,
      assistant: {
        name: assistant.name,
        normalizedName: assistant.normalizedName,
        model: assistant.model ?? null,
      },
    });
  } catch {
    sendAssistantRegistryUnavailable(req, res);
  }
});

export default router;
