import { createHash } from 'node:crypto';

import type {
  NextFunction,
  Request,
  Response,
} from 'express';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import type {
  BackstageNotionPartitionSyncRequestBody,
} from '@shared/jobs/backstageNotionPartitionSyncJob.js';
import type {
  ConfirmationChallengeBinding,
} from '@transport/http/middleware/confirmationChallengeStore.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';

export const BACKSTAGE_NOTION_PARTITION_SYNC_CONFIRMATION_WORKSPACE_ID =
  'backstage-notion-partition-sync';
const BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_HASH_DOMAIN =
  'arcanos:backstage-notion-partition-sync:confirmation-idempotency:v1';

export interface BackstageNotionPartitionSyncConfirmationIntentInput {
  readonly universeId: string;
  readonly request: BackstageNotionPartitionSyncRequestBody;
  readonly idempotencyKey: string;
  readonly configurationGeneration: string;
  readonly configurationDigest: string;
}

function hashIdempotencyKey(value: string): string {
  return createHash('sha256')
    .update(BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_HASH_DOMAIN, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

export function buildBackstageNotionPartitionSyncConfirmationBinding(
  req: Request,
  principalId: string
): ConfirmationChallengeBinding {
  return {
    actorKey: getRequestAuthenticatedActorKey(req),
    principalId,
    workspaceId: BACKSTAGE_NOTION_PARTITION_SYNC_CONFIRMATION_WORKSPACE_ID,
  };
}

/**
 * Bind approval to the exact server-resolved authority generation and stable
 * target. Only a hash of the operator's idempotency key enters the intent.
 */
export function buildBackstageNotionPartitionSyncConfirmationIntent(
  input: BackstageNotionPartitionSyncConfirmationIntentInput
): Record<string, unknown> {
  return {
    protocol: 'backstage-notion-partition-sync-confirmation-v1',
    purpose: BACKSTAGE_NOTION_PARTITION_SYNC_CONFIRMATION_WORKSPACE_ID,
    workspaceId: BACKSTAGE_NOTION_PARTITION_SYNC_CONFIRMATION_WORKSPACE_ID,
    universeId: input.universeId,
    shardKey: input.request.shardKey,
    version: input.request.version,
    idempotencyKeyHash: hashIdempotencyKey(input.idempotencyKey),
    configurationGeneration: input.configurationGeneration,
    configurationDigest: input.configurationDigest,
  };
}

/** Require a consumed one-use challenge after authentication and validation. */
export function requireBackstageNotionPartitionSyncConfirmation(
  req: Request,
  res: Response,
  next: NextFunction,
  intent: BackstageNotionPartitionSyncConfirmationIntentInput
): void {
  const principalId = req.controlPlanePrincipal?.principalId;
  if (!principalId) {
    res.setHeader('Cache-Control', 'no-store');
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
    challengeBinding: buildBackstageNotionPartitionSyncConfirmationBinding(
      req,
      principalId
    ),
    requestFingerprintBody:
      buildBackstageNotionPartitionSyncConfirmationIntent(intent),
    requireChallengeToken: true,
  });
  if (!confirmationAccepted) {
    return;
  }
  if (req.confirmationContext?.usedChallengeToken !== true) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({
      ok: false,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: 'Partition synchronization requires a consumed confirmation challenge.',
      },
    });
    return;
  }
  next();
}
