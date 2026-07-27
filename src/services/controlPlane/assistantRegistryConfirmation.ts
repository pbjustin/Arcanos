import type { Request } from 'express';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import type {
  ConfirmationChallengeBinding,
} from '@transport/http/middleware/confirmationChallengeStore.js';

export const ASSISTANT_REGISTRY_CONFIRMATION_WORKSPACE_ID =
  'assistant-registry';

export function buildAssistantRegistryConfirmationBinding(
  req: Request,
  principalId: string
): ConfirmationChallengeBinding {
  return {
    actorKey: getRequestAuthenticatedActorKey(req),
    principalId,
    workspaceId: ASSISTANT_REGISTRY_CONFIRMATION_WORKSPACE_ID,
  };
}

export function buildAssistantRegistrySyncConfirmationIntent(): Record<
  string,
  unknown
> {
  return {
    protocol: 'assistant-registry-sync-confirmation-v1',
    purpose: ASSISTANT_REGISTRY_CONFIRMATION_WORKSPACE_ID,
    workspaceId: ASSISTANT_REGISTRY_CONFIRMATION_WORKSPACE_ID,
    body: {},
  };
}
