import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  getBackstageNotionPartitionDiagnostics,
  type BackstageNotionPartitionDiagnosticsHttpResult,
  type GetBackstageNotionPartitionDiagnosticsInput,
} from '@services/backstageNotionPartitionDiagnostics.js';
import {
  enqueueBackstageNotionPartitionSyncOperation,
  getBackstageNotionPartitionSyncOperationStatus,
  type BackstageNotionPartitionSyncOperationHttpResult,
  type EnqueueBackstageNotionPartitionSyncOperationInput,
  type GetBackstageNotionPartitionSyncOperationStatusInput,
} from '@services/backstageNotionPartitionSyncOperations.js';
import {
  backstageNotionPartitionSyncBodyParser,
  getBackstageNotionPartitionSyncParsedRequest,
} from '@services/controlPlane/backstageNotionPartitionSyncBodyParser.js';
import {
  requireBackstageNotionPartitionSyncConfirmation,
} from '@services/controlPlane/backstageNotionPartitionSyncConfirmation.js';
import {
  backstageNotionPartitionSyncHttpBoundary,
  resolveBackstageNotionPartitionSyncHttpOperation,
} from '@services/controlPlane/backstageNotionPartitionSyncHttpBoundary.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
  isBackstageNotionPartitionSyncWriterEnabled,
  parseBackstageNotionPartitionConfiguration,
  parseBackstageNotionPartitionedIndexMode,
  resolveBackstageNotionPartitionUniverse,
} from '@shared/backstage/backstageNotionPartitionCore.js';

type ReadEnvironment = (name: string) => string | undefined;
type EnqueuePartitionSync = (
  input: EnqueueBackstageNotionPartitionSyncOperationInput
) => Promise<BackstageNotionPartitionSyncOperationHttpResult>;
type GetPartitionSyncStatus = (
  input: GetBackstageNotionPartitionSyncOperationStatusInput
) => Promise<BackstageNotionPartitionSyncOperationHttpResult>;
type GetPartitionDiagnostics = (
  input: GetBackstageNotionPartitionDiagnosticsInput
) => Promise<BackstageNotionPartitionDiagnosticsHttpResult>;

export interface ApiBackstageNotionPartitionsRouterOptions {
  readonly readEnvironment?: ReadEnvironment;
  readonly enqueueOperation?: EnqueuePartitionSync;
  readonly getOperationStatus?: GetPartitionSyncStatus;
  readonly getDiagnostics?: GetPartitionDiagnostics;
}

interface ConfirmedConfigurationContext {
  readonly generation: string;
  readonly digest: string;
  readonly readEnvironment: ReadEnvironment;
}

const confirmedConfigurationContext = Symbol(
  'backstageNotionPartitionSyncConfirmedConfigurationContext'
);

type BackstageNotionPartitionSyncRouteRequest = Request & {
  [confirmedConfigurationContext]?: ConfirmedConfigurationContext;
};

type ConfirmationTargetResolution =
  | Readonly<{
      status: 'ready';
      context: ConfirmedConfigurationContext;
    }>
  | Readonly<{
      status: 'disabled' | 'unavailable' | 'not_found';
    }>;

function resolveConfirmationTarget(
  readEnvironment: ReadEnvironment,
  universeId: string,
  shardKey: string
): ConfirmationTargetResolution {
  let rawMode: string | undefined;
  try {
    rawMode = readEnvironment(
      BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
    );
  } catch {
    return Object.freeze({ status: 'unavailable' as const });
  }

  const mode = parseBackstageNotionPartitionedIndexMode(rawMode);
  if (!isBackstageNotionPartitionSyncWriterEnabled(mode)) {
    return Object.freeze({ status: 'disabled' as const });
  }
  let rawConfiguration: string | undefined;
  try {
    rawConfiguration = readEnvironment(BACKSTAGE_NOTION_PARTITIONS_ENV_NAME);
  } catch {
    return Object.freeze({ status: 'unavailable' as const });
  }
  const configuration = parseBackstageNotionPartitionConfiguration(
    rawConfiguration
  );
  if (configuration.status !== 'valid') {
    return Object.freeze({ status: 'unavailable' as const });
  }
  const universe = resolveBackstageNotionPartitionUniverse(
    configuration,
    universeId
  );
  if (!universe?.shards.some(shard => shard.shardKey === shardKey)) {
    return Object.freeze({ status: 'not_found' as const });
  }

  // Pin the exact values that produced the confirmed generation and digest.
  // Passing this snapshot into admission closes the confirmation-to-enqueue
  // configuration race without persisting or reflecting either raw value.
  const capturedEnvironment = new Map<string, string | undefined>([
    [BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME, rawMode],
    [BACKSTAGE_NOTION_PARTITIONS_ENV_NAME, rawConfiguration],
  ]);
  return Object.freeze({
    status: 'ready' as const,
    context: Object.freeze({
      generation: configuration.generation,
      digest: configuration.semanticDigest,
      readEnvironment: (name: string): string | undefined => (
        capturedEnvironment.get(name)
      ),
    }),
  });
}

function sendFixedError(
  res: Response,
  statusCode: number,
  code: string,
  message: string
): void {
  if (res.headersSent || res.writableEnded) {
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(statusCode).json({
    ok: false,
    error: { code, message },
  });
}

function sendConfirmationTargetFailure(
  res: Response,
  resolution: Exclude<ConfirmationTargetResolution, { status: 'ready' }>
): void {
  if (resolution.status === 'disabled') {
    sendFixedError(
      res,
      409,
      'BACKSTAGE_NOTION_PARTITION_SYNC_DISABLED',
      'Partition synchronization is disabled.'
    );
    return;
  }
  if (resolution.status === 'not_found') {
    sendFixedError(
      res,
      404,
      'BACKSTAGE_NOTION_PARTITION_SYNC_TARGET_NOT_FOUND',
      'The requested partition synchronization target was not found.'
    );
    return;
  }
  sendFixedError(
    res,
    503,
    'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_UNAVAILABLE',
    'Partition synchronization configuration is unavailable.'
  );
}

function sendOperationResult(
  res: Response,
  result: BackstageNotionPartitionSyncOperationHttpResult
): void {
  if (
    !Number.isSafeInteger(result.statusCode)
    || result.statusCode < 200
    || result.statusCode > 599
  ) {
    throw new Error('Invalid partition synchronization operation status');
  }
  if (result.retryAfterSeconds !== undefined) {
    if (
      !Number.isSafeInteger(result.retryAfterSeconds)
      || result.retryAfterSeconds < 1
      || result.retryAfterSeconds > 3_600
    ) {
      throw new Error('Invalid partition synchronization retry interval');
    }
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
  }
  res.status(result.statusCode).json(result.payload);
}

function logRouteFailure(req: Request, event: string): void {
  try {
    req.logger?.error?.(event, {
      requestId: req.requestId,
      traceId: req.traceId,
      errorType: 'operation_failed',
    });
  } catch {
    // Diagnostics must never alter the bounded public failure.
  }
}

export function createApiBackstageNotionPartitionsRouter(
  options: ApiBackstageNotionPartitionsRouterOptions = {}
): Router {
  const router = Router();
  const readEnvironment = options.readEnvironment ?? (name => getEnv(name));
  const enqueueOperation = options.enqueueOperation
    ?? enqueueBackstageNotionPartitionSyncOperation;
  const getOperationStatus = options.getOperationStatus
    ?? getBackstageNotionPartitionSyncOperationStatus;
  const getDiagnostics = options.getDiagnostics
    ?? getBackstageNotionPartitionDiagnostics;

  router.use(
    backstageNotionPartitionSyncHttpBoundary,
    backstageNotionPartitionSyncBodyParser
  );

  const requireConfiguredConfirmation: RequestHandler = (req, res, next) => {
    const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
    const parsedRequest = getBackstageNotionPartitionSyncParsedRequest(req);
    if (!operation || operation.kind !== 'create' || !parsedRequest) {
      sendFixedError(
        res,
        400,
        'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID',
        'Partition synchronization request is invalid.'
      );
      return;
    }
    const resolution = resolveConfirmationTarget(
      readEnvironment,
      operation.universeId,
      parsedRequest.body.shardKey
    );
    if (resolution.status !== 'ready') {
      sendConfirmationTargetFailure(res, resolution);
      return;
    }
    requireBackstageNotionPartitionSyncConfirmation(
      req,
      res,
      () => {
        (req as BackstageNotionPartitionSyncRouteRequest)[
          confirmedConfigurationContext
        ] = resolution.context;
        next();
      },
      {
        universeId: operation.universeId,
        request: parsedRequest.body,
        idempotencyKey: parsedRequest.idempotencyKey,
        configurationGeneration: resolution.context.generation,
        configurationDigest: resolution.context.digest,
      }
    );
  };

  router.post(
    '/:universeId/syncs',
    requireConfiguredConfirmation,
    async (req, res): Promise<void> => {
      const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
      const parsedRequest = getBackstageNotionPartitionSyncParsedRequest(req);
      const confirmedContext = (req as BackstageNotionPartitionSyncRouteRequest)[
        confirmedConfigurationContext
      ];
      if (
        !operation
        || operation.kind !== 'create'
        || !parsedRequest
        || !confirmedContext
      ) {
        sendFixedError(
          res,
          400,
          'BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_INVALID',
          'Partition synchronization request is invalid.'
        );
        return;
      }
      const liveResolution = resolveConfirmationTarget(
        readEnvironment,
        operation.universeId,
        parsedRequest.body.shardKey
      );
      if (liveResolution.status !== 'ready') {
        sendConfirmationTargetFailure(res, liveResolution);
        return;
      }
      if (
        liveResolution.context.generation !== confirmedContext.generation
        || liveResolution.context.digest !== confirmedContext.digest
      ) {
        sendFixedError(
          res,
          503,
          'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_UNAVAILABLE',
          'Partition synchronization configuration is unavailable.'
        );
        return;
      }
      try {
        const result = await enqueueOperation({
          universeId: operation.universeId,
          body: parsedRequest.body,
          actorKey: getRequestAuthenticatedActorKey(req),
          idempotencyKey: parsedRequest.idempotencyKey,
          correlationId: req.traceId ?? req.requestId ?? null,
          dependencies: {
            readEnvironment: liveResolution.context.readEnvironment,
          },
        });
        try {
          req.logger?.info?.('backstage_notion_partition_sync.request_completed', {
            requestId: req.requestId,
            traceId: req.traceId,
            universeId: operation.universeId,
            shardKey: parsedRequest.body.shardKey,
            statusCode: result.statusCode,
          });
        } catch {
          // Audit logging must never alter the operation response.
        }
        sendOperationResult(res, result);
      } catch {
        logRouteFailure(
          req,
          'backstage_notion_partition_sync.enqueue_failed'
        );
        sendFixedError(
          res,
          500,
          'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
          'Failed to enqueue partition synchronization.'
        );
      }
    }
  );

  router.get('/:universeId/syncs/:syncId', async (req, res): Promise<void> => {
    const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
    if (!operation || operation.kind !== 'status') {
      sendFixedError(
        res,
        404,
        'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
        'The partition synchronization was not found.'
      );
      return;
    }
    try {
      const result = await getOperationStatus({
        universeId: operation.universeId,
        syncId: operation.syncId,
        actorKey: getRequestAuthenticatedActorKey(req),
      });
      try {
        req.logger?.info?.('backstage_notion_partition_sync.status_read', {
          requestId: req.requestId,
          traceId: req.traceId,
          universeId: operation.universeId,
          syncId: operation.syncId,
          statusCode: result.statusCode,
        });
      } catch {
        // Audit logging must never alter the operation response.
      }
      sendOperationResult(res, result);
    } catch {
      logRouteFailure(
        req,
        'backstage_notion_partition_sync.status_read_failed'
      );
      sendFixedError(
        res,
        500,
        'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
        'Failed to read partition synchronization status.'
      );
    }
  });

  router.get('/:universeId/diagnostics', async (req, res): Promise<void> => {
    const operation = resolveBackstageNotionPartitionSyncHttpOperation(req);
    if (!operation || operation.kind !== 'diagnostics') {
      sendFixedError(
        res,
        404,
        'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_NOT_FOUND',
        'The partition diagnostics target was not found.'
      );
      return;
    }
    try {
      const result = await getDiagnostics({
        universeId: operation.universeId,
        dependencies: { readEnvironment },
      });
      try {
        req.logger?.info?.('backstage_notion_partition_diagnostics.read', {
          requestId: req.requestId,
          traceId: req.traceId,
          universeId: operation.universeId,
          statusCode: result.statusCode,
        });
      } catch {
        // Aggregate-only audit logging must never alter the diagnostic response.
      }
      sendOperationResult(res, result);
    } catch {
      logRouteFailure(
        req,
        'backstage_notion_partition_diagnostics.read_failed'
      );
      sendFixedError(
        res,
        500,
        'BACKSTAGE_NOTION_PARTITION_DIAGNOSTICS_INTERNAL_ERROR',
        'Failed to read partition diagnostics.'
      );
    }
  });

  return router;
}

export default createApiBackstageNotionPartitionsRouter();
