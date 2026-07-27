import type { Request } from 'express';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import type {
  ConfirmationChallengeBinding,
} from '@transport/http/middleware/confirmationChallengeStore.js';

const CEF_CONFIRMATION_WORKSPACE_ID = 'cef:control-plane';

export function buildCefConfirmationBinding(
  req: Request,
  principalId: string
): ConfirmationChallengeBinding {
  return {
    actorKey: getRequestAuthenticatedActorKey(req),
    principalId,
    workspaceId: CEF_CONFIRMATION_WORKSPACE_ID,
  };
}

export function buildCefDispatchConfirmationState(
  req: Request
): Record<string, unknown> {
  return {
    decision: req.dispatchDecision ?? null,
    rerouted: req.dispatchRerouted === true,
    conflictCode: req.dispatchConflictCode ?? null,
    memoryVersion: req.memoryVersion ?? null,
  };
}
