import type { Request } from 'express';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import type {
  ConfirmationChallengeBinding,
} from '@transport/http/middleware/confirmationChallengeStore.js';

const AFOL_CONFIRMATION_WORKSPACE_ID = 'afol:control-plane';

export function buildAfolConfirmationBinding(
  req: Request,
  principalId: string
): ConfirmationChallengeBinding {
  return {
    actorKey: getRequestAuthenticatedActorKey(req),
    principalId,
    workspaceId: AFOL_CONFIRMATION_WORKSPACE_ID,
  };
}

export function buildAfolDecisionConfirmationIntent(
  req: Request
): Record<string, unknown> {
  return {
    protocol: 'afol-decision-confirmation-v1',
    body: req.body,
    dispatch: {
      decision: req.dispatchDecision ?? null,
      rerouted: req.dispatchRerouted === true,
      conflictCode: req.dispatchConflictCode ?? null,
      memoryVersion: req.memoryVersion ?? null,
    },
  };
}
