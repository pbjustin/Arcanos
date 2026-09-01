/**
 * Autonomous DB-backed job worker for ARCANOS async execution.
 *
 * - Claims due jobs from `job_data`
 * - Executes Trinity or DAG nodes
 * - Maintains heartbeats and leases
 * - Applies retry/backoff, budget guards, and stale-job inspection
 * - Persists worker health snapshots for cross-instance inspection
 */

import {
  createClaimedJobFence,
  getJobById,
  JobRepositoryUnavailableError,
  updateClaimedJobTerminal,
  type ClaimedJobFence
} from '@core/db/repositories/jobRepository.js';
import type { JobData } from '@core/db/schema.js';
import { postgresQueueSchedulerAdapter } from '@core/scheduler/postgresAdapter.js';
import {
  initializeDatabaseWithSchema as initializeDatabase,
  getStatus as getDatabaseStatus
} from '@core/db/index.js';
import { getConfig, getStableWorkerRuntimeMode } from '@platform/runtime/unifiedConfig.js';
import { configureBackendUnifiedOpenAIClient } from '@core/init-openai.js';
import {
  classifyWorkerAiBudgetError,
  getOpenAIAdapter,
  normalizeWorkerAiBudgetError
} from '@core/adapters/openai.adapter.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  buildCompletedQueuedAskOutput,
  parseQueuedAskJobInput
} from '@shared/ask/asyncAskJob.js';
import {
  isQueuedGptJobCancellationPrivacySensitive,
  parseQueuedGptJobInput,
  resolveProtectedBackstageQueuedGptJobAction,
  type QueuedGptJobInput,
} from '@shared/gpt/asyncGptJob.js';
import {
  extractGptDispatchPromptText,
  resolveRequestedGptAction,
} from '@shared/gpt/gptRequestAction.js';
import { resolveGptModuleRequestedActionAlias } from '@shared/gpt/gptModuleAction.js';
import { resolveGptModuleMapEntry } from '@shared/gpt/gptModuleMapResolution.js';
import {
  BACKSTAGE_ACTIONS,
  BACKSTAGE_MODULE_NAME,
  isBackstageGptRoute,
} from '@shared/backstage/backstageActionPolicy.js';
import {
  PROTECTED_BACKSTAGE_JOB_CANCELLATION_MESSAGE,
  protectBackstageQueuedGptJobOutput,
} from '@shared/backstage/backstageQueuedJobResultProtection.js';
import {
  buildProtectedBackstageFailureEnvelope,
  buildProtectedBackstageFailureMessage,
  readProtectedBackstageCompletionProvenance,
  resolveBackstageProtectedFailureCode,
} from '@shared/backstage/backstageProtectedFailure.js';
import {
  resolveBackstageProviderDeferralDelayMs,
  resolveBackstageExecutionBudgetPolicy,
  resolveBackstageWorkerOperationDeadlineAt,
  type BackstageExecutionBudgetPolicy,
} from '@shared/backstage/backstageExecutionBudget.js';
import {
  isCooperativeDeadlineExceededError,
  runWithCooperativeAbortDrain,
} from '@shared/async/cooperativeAbortDrain.js';
import { resolveJobLeaseHeartbeatIntervalMs } from '@shared/jobs/jobLeaseTiming.js';
import { BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE } from '@shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_CANON_COMMIT_UNKNOWN_JOB_REUSE_REASON,
  BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
  BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE_ERROR_CODE,
  isBackstageCanonCommitOutcomeUnknown
} from '@services/backstageBookerContracts.js';
import { BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE } from '@services/backstageNotionRag.js';
import {
  buildBridgeSmokeCompletedOutput,
  isQueuedBridgeSmokeJobInput
} from '@shared/gpt/bridgeSmoke.js';
import { parseDagNodeJobInput } from '../jobs/jobSchema.js';
import { runDagNodeJob } from './taskRunners.js';
import {
  WorkerAutonomyService,
  getWorkerAutonomySettings,
  classifyWorkerExecutionError
} from '@services/workerAutonomyService.js';
import { classifyDagNodeFailureForWorkerRetry } from './jobFailureClassification.js';
import {
  advanceClaimedJobAbortState,
  buildJobRunnerSlotDefinitions,
  commitAllWorkerSlotsReadyOrThrow,
  computeDeterministicIntervalJitterMs,
  createNonOverlappingTaskRunner,
  createWorkerOperationalStateReporter,
  emitWorkerBootstrapReadySignal,
  isEntrypointModule,
  isRetryableJobRunnerDatabaseBootstrapError,
  resolveJobRunnerIdleBackoffDelayMs,
  resolveJobRunnerEntrypointRuntimeMode,
  resolveJobRunnerDatabaseBootstrapSettings,
  resolveProviderPauseMs,
  resolveJobRunnerRuntimeSettings,
  selectJobRunnerSlotTransientRetryEvent,
  shouldPersistClaimedJobCancellation,
  waitForWorkerStartupReadiness,
  type ClaimedJobAbortCause,
  type ClaimedJobAbortState,
  type JobRunnerDatabaseBootstrapSettings,
  type JobRunnerRuntimeSettings,
  type JobRunnerSlotDefinition
} from './jobRunnerRuntime.js';
import { createDagNodeRunPromptBridge } from './dagNodePromptBridge.js';
import { runWorkerTrinityPrompt } from './trinityWorkerPipeline.js';
import { isTrinityDagGptAccessEnabled } from '@services/trinity/adapter.js';
import { sleep } from '@shared/sleep.js';
import {
  recordGptJobEvent,
  recordGptJobTiming,
  recordWorkerJobDuration
} from '@platform/observability/appMetrics.js';
import {
  createAiExecutionContext,
  getAiExecutionContext,
  runWithAiExecutionContext,
  summarizeAiExecutionContext,
  type AiExecutionContext,
  type WorkerAiCallBudget,
} from '@services/openai/aiExecutionContext.js';
import {
  createAbortError,
  getRequestAbortSignal,
  isAbortError,
  runWithRequestAbortContext,
} from '@arcanos/runtime';
import {
  buildNonReusableGptResultAutonomyState,
  computeGptJobLifecycleDeadlines,
  summarizeGptJobTimings
} from '@shared/gpt/gptJobLifecycle.js';
import {
  getOpenAIProviderRuntimeStatus,
  probeOpenAIProviderHealth,
  syncOpenAIProviderRuntime,
  type OpenAIProviderFailureCategory
} from '@services/openai/serviceHealth.js';
import { routeGptRequest } from '@routes/_core/gptDispatch.js';
import { getGptModuleMap } from '@platform/runtime/gptRouterConfig.js';
import { detectBackstageBookerIntent } from '@services/backstageBookerRouteShortcut.js';
import {
  runWithBackstageLegacyQueuedExecution,
  runWithBackstageProtectedQueuedExecution,
} from '@services/backstageNotionEnrichmentAuthorization.js';
import {
  loadBackstageNotionPartitionCutoverGateEvidenceSet,
} from '@services/backstageNotionPartitionCutoverEvidence.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { recordJobEvent } from '@core/db/repositories/jobEventRepository.js';
import { initializeModuleRegistry } from '@services/moduleRegistry.js';
import {
  configureDefaultArcanosCoreRuntimeProviders
} from '@services/arcanosCoreRuntimeProviders.js';
import {
  executeQueuedGamingSourceIngestion,
  GAMING_SOURCE_INGESTION_GPT_ID,
  GAMING_SOURCE_INGESTION_REASON,
  GAMING_SOURCE_INGESTION_REQUEST_PATH,
  GAMING_SOURCE_REFRESH_REQUEST_PATH,
  parseQueuedGamingSourceIngestionBody
} from '@services/gamingSourceIngestion.js';
import {
  createBackstageNotionSynchronizationCoordinator,
  ensureBackstageNotionWorkerReadiness,
  startBackstageNotionSyncLoop,
  type BackstageNotionSyncLoopHandle,
} from './backstageNotionSyncLoop.js';
import {
  resolveBackstageNotionPartitionShadowPolicy,
  runBackstageNotionWorkerReadinessGate,
  startBackstageNotionPartitionShadowLoop,
  type BackstageNotionPartitionShadowLoopHandle,
} from './backstageNotionPartitionShadowLoop.js';
import {
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
  BACKSTAGE_NOTION_PARTITION_SYNC_MAX_AI_CALLS,
} from '@shared/jobs/backstageNotionPartitionSyncJob.js';
import {
  createBackstageNotionPartitionSyncJobExecutor,
  type BackstageNotionPartitionSyncJobExecutor,
} from './backstageNotionPartitionSyncJob.js';

interface JobExecutionOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  output: unknown;
  errorMessage?: string;
  retryable?: boolean;
  completionAutonomyState?: Record<string, unknown>;
  completionWinsLateCancellation?: boolean;
}

type OpenAIClient = ReturnType<typeof initOpenAIClient>;

interface WorkerProviderClientState {
  client: OpenAIClient | null;
  configVersion: string | null;
  pausedUntil: string | null;
  providerRecovered: boolean;
  providerRecoveryCategory: string | null;
  providerRecoveryNextRetryAt: string | null;
}

export interface WorkerProviderDependencyState {
  unavailable: boolean;
  reason: string | null;
  retryAt: string | null;
  revision: number;
  recoveryPromise: Promise<WorkerProviderClientState> | null;
}

export function createWorkerProviderDependencyState(): WorkerProviderDependencyState {
  return {
    unavailable: false,
    reason: null,
    retryAt: null,
    revision: 0,
    recoveryPromise: null
  };
}

const QUEUED_GPT_PROMPT_KEYS = ['prompt', 'message', 'query', 'text', 'content', 'userInput'] as const;
const LEGACY_BACKSTAGE_JOB_CANCELLATION_MESSAGE =
  'Legacy Backstage generation cancellation requested during compatibility drain.';
const LEGACY_BACKSTAGE_DRAIN_ERROR_CODE = 'BACKSTAGE_LEGACY_DRAIN_FAILED';
const LEGACY_BACKSTAGE_DRAIN_ERROR_MESSAGE =
  'Legacy Backstage generation failed during compatibility drain.';

function isQueuedGptDispatchFailureRetryable(error: {
  code: string;
  details?: unknown;
}): boolean {
  return error.code === 'MODULE_TIMEOUT'
    || error.code === 'MODULE_ERROR'
    || (
      (
        error.code === BACKSTAGE_ROSTER_PERSISTENCE_ERROR_CODE
        || error.code === BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE
        || error.code === BACKSTAGE_NOTION_INDEX_UNAVAILABLE_ERROR_CODE
        || error.code === BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE_ERROR_CODE
      )
      && typeof error.details === 'object'
      && error.details !== null
      && (error.details as { retryable?: unknown }).retryable === true
    );
}

interface QueuedBackstageExecutionClassification {
  canonicalQueuedAction: string | undefined;
  isUnprotectedBackstageGeneration: boolean;
  legacyBackstageQueuedExecution: boolean;
  legacyQueueDrainContextCandidate: boolean;
  requestedBackstageAction: string | null;
}

type QueuedGptCancellationPrivacy = 'protected' | 'legacy';

interface QueuedGptExecutionPrivacyState {
  cancellationPrivacy: QueuedGptCancellationPrivacy | null;
}

async function classifyQueuedBackstageExecution(
  input: QueuedGptJobInput
): Promise<QueuedBackstageExecutionClassification> {
  const protectedBackstageQueuedExecution = input.protectedBackstage !== undefined;
  let queuedModuleName: string | null = null;
  if (!protectedBackstageQueuedExecution) {
    try {
      const gptModuleMap = await getGptModuleMap();
      queuedModuleName = resolveGptModuleMapEntry(
        input.gptId,
        gptModuleMap
      )?.entry.module ?? null;
    } catch {
      // Normal routing retains ownership of unavailable-map diagnostics below.
    }
  }
  const queuedTargetsBackstage =
    queuedModuleName === BACKSTAGE_MODULE_NAME
    || isBackstageGptRoute(input.gptId);
  const requestedQueuedAction = resolveRequestedGptAction({ body: input.body });
  const queuedAvailableActions: readonly string[] = queuedTargetsBackstage
    ? BACKSTAGE_ACTIONS
    : queuedModuleName === 'ARCANOS:CORE'
      ? ['query']
      : [];
  const canonicalQueuedAction = resolveGptModuleRequestedActionAlias(
    requestedQueuedAction ?? undefined,
    queuedAvailableActions,
  );
  const requestedBackstageAction = queuedTargetsBackstage
    ? canonicalQueuedAction ?? null
    : null;
  const automaticBackstageGeneration =
    !protectedBackstageQueuedExecution
    && input.bypassIntentRouting !== true
    && (
      queuedModuleName === BACKSTAGE_MODULE_NAME
      || queuedModuleName === 'ARCANOS:CORE'
    )
    && (
      canonicalQueuedAction === undefined
      || canonicalQueuedAction === 'query'
    )
    && detectBackstageBookerIntent(
      extractGptDispatchPromptText(input.body) ?? input.prompt ?? null
    ) !== null;
  const isUnprotectedBackstageGeneration =
    !protectedBackstageQueuedExecution
    && (
      (
        queuedTargetsBackstage
        && (
          requestedBackstageAction === null
          || requestedBackstageAction === 'generateBooking'
          || requestedBackstageAction === 'generateBookingWithHRC'
        )
      )
      || automaticBackstageGeneration
    );
  const legacyQueuedProducerExecution =
    !protectedBackstageQueuedExecution
    && input.producerContract === undefined;
  const legacyBackstageQueuedExecution =
    isUnprotectedBackstageGeneration
    && legacyQueuedProducerExecution;

  return {
    canonicalQueuedAction,
    isUnprotectedBackstageGeneration,
    legacyBackstageQueuedExecution,
    legacyQueueDrainContextCandidate: legacyQueuedProducerExecution,
    requestedBackstageAction,
  };
}

function hasProtectedBackstageQueuedGptMarker(rawInput: unknown): boolean {
  return (
    typeof rawInput === 'object'
    && rawInput !== null
    && !Array.isArray(rawInput)
    && Object.prototype.hasOwnProperty.call(rawInput, 'protectedBackstage')
  );
}

function setQueuedGptExecutionPrivacy(
  state: QueuedGptExecutionPrivacyState | undefined,
  cancellationPrivacy: QueuedGptCancellationPrivacy
): void {
  if (state) {
    state.cancellationPrivacy = cancellationPrivacy;
  }
}

function buildProtectedBackstageCancellationOutput(params: {
  jobId: string;
  rawInput: unknown;
  action: 'generateBooking' | 'generateBookingWithHRC';
}): unknown | null {
  const code = 'BACKSTAGE_ASYNC_EXECUTION_FAILED' as const;
  try {
    return protectBackstageQueuedGptJobOutput({
      jobId: params.jobId,
      rawInput: params.rawInput,
      output: buildProtectedBackstageFailureEnvelope({
        gptId: 'backstage-booker',
        action: params.action,
        code,
      }),
    });
  } catch {
    return null;
  }
}

async function resolvePreExecutionQueuedGptCancellationPrivacy(
  rawInput: unknown
): Promise<QueuedGptCancellationPrivacy | null> {
  if (
    hasProtectedBackstageQueuedGptMarker(rawInput)
  ) {
    return 'protected';
  }
  return isQueuedGptJobCancellationPrivacySensitive(rawInput)
    ? 'legacy'
    : null;
}

interface WorkerHeartbeatLoopHandle {
  stop(): void;
}

let workerProcessShutdownRequested = false;
let workerProcessShutdownSignal: NodeJS.Signals | null = null;
const workerProcessShutdownController = new AbortController();

function requestWorkerProcessShutdown(signal: NodeJS.Signals): void {
  if (workerProcessShutdownRequested) {
    return;
  }

  workerProcessShutdownRequested = true;
  workerProcessShutdownSignal = signal;
  workerProcessShutdownController.abort(createAbortError(`Worker process shutdown requested by ${signal}`));
  logger.warn('job_runner.shutdown.requested', {
    module: 'worker',
    signal
  });
}

function isWorkerProcessShutdownRequested(): boolean {
  return workerProcessShutdownRequested;
}

async function sleepUntilWorkerProcessSignal(milliseconds: number): Promise<void> {
  if (isWorkerProcessShutdownRequested()) {
    return;
  }

  try {
    await sleep(milliseconds, { signal: workerProcessShutdownController.signal });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return;
    }
    throw error;
  }
}

function logWorkerShutdownDuringBootstrap(workerId: string, phase: string): void {
  logger.info('worker.shutdown.during_bootstrap_retry', {
    module: 'job-runner',
    workerId,
    phase,
    signal: workerProcessShutdownSignal ?? 'unknown'
  });
}

process.once('SIGTERM', () => requestWorkerProcessShutdown('SIGTERM'));
process.once('SIGINT', () => requestWorkerProcessShutdown('SIGINT'));

function createOverlapSkipLogger(workerId: string, source: string) {
  return (event: { taskName: string; skippedCount: number; runningForMs: number | null }) => {
    logger.warn('worker.interval_task.overlap_skipped', {
      module: 'worker',
      workerId,
      source,
      taskName: event.taskName,
      skippedCount: event.skippedCount,
      runningForMs: event.runningForMs,
      reason: 'task skipped due to overlap'
    });
  };
}

function initOpenAIClient() {
  const unified = getConfig();
  const apiKey = unified.openaiApiKey?.trim() || '';
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing (unified.openaiApiKey empty)');
  }

  const adapterConfig = {
    apiKey,
    baseURL: unified.openaiBaseUrl,
    timeout: unified.workerApiTimeoutMs,
    maxRetries: unified.openaiMaxRetries,
    defaultModel: unified.defaultModel
  };

  const adapter = getOpenAIAdapter(adapterConfig);
  return adapter.getClient();
}

function readOptionalPositiveIntegerEnv(name: string): number | undefined {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function resolveProtectedBackstageWorkerBudget(
  action: 'generateBooking' | 'generateBookingWithHRC'
): BackstageExecutionBudgetPolicy {
  return resolveBackstageExecutionBudgetPolicy({
    profile: 'queued_generation',
    action,
    configuration: {
      workerJobTimeoutMs: readOptionalPositiveIntegerEnv(
        'BOOKER_WORKER_JOB_TIMEOUT_MS'
      ),
      workerGenerationStageTimeoutMs: readOptionalPositiveIntegerEnv(
        'BOOKER_WORKER_GENERATION_STAGE_TIMEOUT_MS'
      ),
      workerRecoveryStageTimeoutMs: readOptionalPositiveIntegerEnv(
        'BOOKER_REPAIR_STAGE_TIMEOUT_MS'
      ),
    },
  });
}

function initializeWorkerOpenAIAdapterIfConfigured(): void {
  configureBackendUnifiedOpenAIClient();
  const unified = getConfig();
  if (!unified.openaiApiKey?.trim()) {
    return;
  }

  syncOpenAIProviderRuntime({
    reason: 'job_runner:backstage_notion_readiness'
  });
  initOpenAIClient();
}

function hasDatabaseConfiguration(): boolean {
  const directUrlConfigured = [
    'DATABASE_URL',
    'DATABASE_PRIVATE_URL',
    'DATABASE_PUBLIC_URL'
  ].some(key => Boolean(process.env[key]?.trim()));
  const pgVarsConfigured = [
    'PGUSER',
    'PGPASSWORD',
    'PGHOST',
    'PGPORT',
    'PGDATABASE'
  ].every(key => Boolean(process.env[key]?.trim()));

  return directUrlConfigured || pgVarsConfigured;
}

function computeDatabaseBootstrapRetryDelayMs(
  attempt: number,
  settings: JobRunnerDatabaseBootstrapSettings
): number {
  const backoffMs = settings.retryMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(backoffMs, settings.maxRetryMs);
}

async function initializeJobRunnerDatabaseWithRetry(
  workerId: string,
  settings: JobRunnerDatabaseBootstrapSettings = resolveJobRunnerDatabaseBootstrapSettings()
): Promise<void> {
  if (!hasDatabaseConfiguration()) {
    throw new Error('Database not configured (no database URL or PG* credentials found)');
  }

  let attempt = 0;

  while (true) {
    attempt += 1;
    let dbInitialized = false;
    try {
      dbInitialized = await initializeDatabase(workerId);
    } catch (error: unknown) {
      const message = resolveErrorMessage(error);
      if (
        !isRetryableJobRunnerDatabaseBootstrapError(error) ||
        (settings.maxAttempts !== null && attempt >= settings.maxAttempts)
      ) {
        throw error;
      }

      const delayMs = computeDatabaseBootstrapRetryDelayMs(attempt, settings);
      logger.warn('worker.database_bootstrap.retry_after_exception', {
        module: 'job-runner',
        workerId,
        attempt,
        delayMs
      }, { errorMessage: message }, error instanceof Error ? error : undefined);
      await sleepUntilWorkerProcessSignal(delayMs);
      if (isWorkerProcessShutdownRequested()) {
        logWorkerShutdownDuringBootstrap(workerId, 'database_exception_retry');
        return;
      }
      continue;
    }
    const dbStatus = getDatabaseStatus();

    if (dbInitialized && dbStatus.connected) {
      if (attempt > 1) {
        logger.info('worker.database_bootstrap.recovered', {
          module: 'job-runner',
          workerId,
          attempt
        });
      }
      return;
    }

    const statusMessage = `connected=${dbStatus.connected}, error=${dbStatus.error ?? 'none'}`;
    if (settings.maxAttempts !== null && attempt >= settings.maxAttempts) {
      throw new Error(`Database not configured (${statusMessage}) after ${attempt} attempt(s)`);
    }

    const delayMs = computeDatabaseBootstrapRetryDelayMs(attempt, settings);
    logger.warn('worker.database_bootstrap.retry_after_failed_status', {
      module: 'job-runner',
      workerId,
      attempt,
      delayMs
    }, { statusMessage });
    await sleepUntilWorkerProcessSignal(delayMs);
    if (isWorkerProcessShutdownRequested()) {
      logWorkerShutdownDuringBootstrap(workerId, 'database_status_retry');
      return;
    }
  }
}

async function bootstrapWorkerAutonomyWithRetry(
  autonomyService: WorkerAutonomyService,
  notes: string[],
  settings: JobRunnerDatabaseBootstrapSettings
): Promise<Awaited<ReturnType<WorkerAutonomyService['bootstrap']>>> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      const bootstrapResult = await autonomyService.bootstrap(notes);
      if (attempt > 1) {
        logger.info('worker.autonomy_bootstrap.recovered', {
          module: 'job-runner',
          workerId: autonomyService.getWorkerId(),
          attempt
        });
      }
      return bootstrapResult;
    } catch (error: unknown) {
      const message = resolveErrorMessage(error);
      if (
        !isRetryableJobRunnerDatabaseBootstrapError(error) ||
        (settings.maxAttempts !== null && attempt >= settings.maxAttempts)
      ) {
        throw error;
      }

      const delayMs = computeDatabaseBootstrapRetryDelayMs(attempt, settings);
      logger.warn('worker.autonomy_bootstrap.retry_after_failed_status', {
        module: 'job-runner',
        workerId: autonomyService.getWorkerId(),
        attempt,
        delayMs
      }, { errorMessage: message }, error instanceof Error ? error : undefined);
      await sleepUntilWorkerProcessSignal(delayMs);
      if (isWorkerProcessShutdownRequested()) {
        logWorkerShutdownDuringBootstrap(autonomyService.getWorkerId(), 'autonomy_retry');
        throw createAbortError('Worker process shutdown requested during autonomy bootstrap retry.');
      }
    }
  }
}

function readProviderErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function readProviderErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const candidate = error as {
    code?: unknown;
    cause?: { code?: unknown };
  };
  const code = candidate.code ?? candidate.cause?.code;
  return typeof code === 'string' && code.trim().length > 0
    ? code.trim().toUpperCase()
    : null;
}

/**
 * Identify failures that mean the worker's configured OpenAI dependency needs
 * a process-wide recovery probe. Deterministic request/content errors are left
 * to the normal job failure classifier and do not pause sibling queue slots.
 */
export function classifyWorkerProviderRuntimeFailure(
  error: unknown,
  message = resolveErrorMessage(error)
): { category: OpenAIProviderFailureCategory } | null {
  const status = readProviderErrorStatus(error);
  const code = readProviderErrorCode(error);
  const normalizedMessage = message.toLowerCase();
  const candidate = error && typeof error === 'object'
    ? error as { name?: unknown; constructor?: { name?: unknown } }
    : null;
  const errorType = [candidate?.name, candidate?.constructor?.name]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (errorType.includes('apiuseraborterror')) {
    return null;
  }
  if (
    errorType.includes('apiconnectiontimeouterror') ||
    status === 408 ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    normalizedMessage.includes('request timed out') ||
    normalizedMessage.includes('connection timed out')
  ) {
    return { category: 'timeout' };
  }
  if (
    errorType.includes('apiconnectionerror') ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_SOCKET' ||
    normalizedMessage.includes('connection error') ||
    normalizedMessage.includes('fetch failed') ||
    normalizedMessage.includes('socket hang up') ||
    normalizedMessage.includes('getaddrinfo')
  ) {
    return { category: 'network' };
  }
  if (
    status === 401 ||
    status === 403 ||
    errorType.includes('authenticationerror') ||
    errorType.includes('permissiondeniederror') ||
    normalizedMessage.includes('incorrect api key') ||
    normalizedMessage.includes('invalid api key') ||
    normalizedMessage.includes('api key missing') ||
    normalizedMessage.includes('authentication')
  ) {
    return { category: 'authentication' };
  }
  if (
    status === 429 ||
    errorType.includes('ratelimiterror') ||
    normalizedMessage.includes('rate limit')
  ) {
    return { category: 'rate_limited' };
  }
  if (
    status !== null && status >= 500 ||
    errorType.includes('internalservererror') ||
    normalizedMessage.includes('provider probe') ||
    normalizedMessage.includes('openai internal error') ||
    normalizedMessage.includes('openai service unavailable')
  ) {
    return { category: 'provider_error' };
  }
  if (normalizedMessage.includes('circuit breaker')) {
    return { category: 'circuit_open' };
  }
  if (
    normalizedMessage.includes('openai_client_unavailable') ||
    normalizedMessage.includes('openai api key') ||
    normalizedMessage.includes('adapter unavailable')
  ) {
    return { category: 'missing_client' };
  }
  return null;
}

function hasQueuedGptPromptField(body: Record<string, unknown>): boolean {
  for (const key of QUEUED_GPT_PROMPT_KEYS) {
    const candidate = body[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return true;
    }
  }

  if (!Array.isArray(body.messages)) {
    return false;
  }

  return body.messages.some((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return false;
    }

    const candidate = entry as Record<string, unknown>;

    return (
      candidate.role === 'user' &&
      typeof candidate.content === 'string' &&
      candidate.content.trim().length > 0
    );
  });
}

function hydrateQueuedGptBodyPrompt(
  body: Record<string, unknown>,
  prompt: string | undefined
): Record<string, unknown> {
  if (!prompt || hasQueuedGptPromptField(body)) {
    return body;
  }

  return {
    ...body,
    prompt
  };
}

function attachQueuedGptExecutionMetadata(
  body: Record<string, unknown>,
  params: {
    requestPath?: string;
    executionModeReason?: string;
    routeHint?: string;
  }
): Record<string, unknown> {
  return {
    ...body,
    __arcanosSourceEndpoint: params.requestPath ?? 'worker.gpt.background',
    ...(params.executionModeReason
      ? { __arcanosExecutionReason: params.executionModeReason }
      : {}),
    ...(params.routeHint
      ? { __arcanosRequestedAction: params.routeHint }
      : {})
  };
}

async function ensureOpenAIClientForSlot(params: {
  workerId: string;
  currentClient: OpenAIClient | null;
  currentConfigVersion: string | null;
  workerBudget: WorkerAiCallBudget;
  forceReload?: boolean;
}): Promise<WorkerProviderClientState> {
  const sync = syncOpenAIProviderRuntime({
    forceReload: params.forceReload ?? false,
    reason: `job_runner:${params.workerId}`
  });
  const configVersion = sync.runtime.configVersion;
  const configChanged = configVersion !== params.currentConfigVersion;
  const runtimeBeforeProbe = sync.runtime;

  if (params.currentClient && !configChanged && !params.forceReload) {
    return {
      client: params.currentClient,
      configVersion,
      pausedUntil: sync.runtime.nextRetryAt,
      providerRecovered: false,
      providerRecoveryCategory: null,
      providerRecoveryNextRetryAt: null
    };
  }

  if (
    sync.runtime.nextRetryAt &&
    Date.parse(sync.runtime.nextRetryAt) > Date.now()
  ) {
    return {
      client: null,
      configVersion,
      pausedUntil: sync.runtime.nextRetryAt,
      providerRecovered: false,
      providerRecoveryCategory: null,
      providerRecoveryNextRetryAt: null
    };
  }

  const probingAfterProviderFailure = Boolean(
    runtimeBeforeProbe.lastFailureAt ||
    runtimeBeforeProbe.lastFailureCategory ||
    runtimeBeforeProbe.consecutiveFailures > 0
  );
  if (probingAfterProviderFailure) {
    logger.info('worker.circuit_breaker.reset_probe', {
      module: 'job-runner',
      workerId: params.workerId,
      providerFailureCategory: runtimeBeforeProbe.lastFailureCategory,
      providerNextRetryAt: runtimeBeforeProbe.nextRetryAt
    });
  }

  const providerProbeContext = createAiExecutionContext({
    sourceType: 'background',
    sourceName: 'openai-provider-health',
    requestId: `job_runner:${params.workerId}`,
    workerBudget: createWorkerProviderProbeBudget(params.workerBudget)
  });
  const providerProbe = await runWithAiExecutionContext(
    providerProbeContext,
    () => probeOpenAIProviderHealth({
      source: `job_runner:${params.workerId}`
    })
  );
  rethrowRecordedWorkerBudgetFailure(providerProbeContext);
  if (!providerProbe.ok) {
    return {
      client: null,
      configVersion: providerProbe.runtime.configVersion,
      pausedUntil: providerProbe.runtime.nextRetryAt,
      providerRecovered: false,
      providerRecoveryCategory: null,
      providerRecoveryNextRetryAt: null
    };
  }

  try {
    const client = initOpenAIClient();
    if (probingAfterProviderFailure) {
      logger.info('worker.circuit_breaker.reset', {
        module: 'job-runner',
        workerId: params.workerId,
        providerFailureCategory: runtimeBeforeProbe.lastFailureCategory,
        providerNextRetryAt: runtimeBeforeProbe.nextRetryAt
      });
    }

    return {
      client,
      configVersion: providerProbe.runtime.configVersion,
      pausedUntil: providerProbe.runtime.nextRetryAt,
      providerRecovered: probingAfterProviderFailure,
      providerRecoveryCategory: runtimeBeforeProbe.lastFailureCategory,
      providerRecoveryNextRetryAt: runtimeBeforeProbe.nextRetryAt
    };
  } catch (error: unknown) {
    logger.error(
      'worker.openai_client.initialization_failed_after_healthy_probe',
      {
        module: 'job-runner',
        workerId: params.workerId
      },
      { errorMessage: resolveErrorMessage(error) },
      error instanceof Error ? error : undefined
    );
    return {
      client: null,
      configVersion: providerProbe.runtime.configVersion,
      pausedUntil: getOpenAIProviderRuntimeStatus().nextRetryAt,
      providerRecovered: false,
      providerRecoveryCategory: null,
      providerRecoveryNextRetryAt: null
    };
  }
}

function markWorkerProviderDependencyUnavailable(
  state: WorkerProviderDependencyState,
  reason: string,
  retryAt: string | null
): void {
  state.unavailable = true;
  state.reason = reason;
  state.retryAt = retryAt;
  state.revision += 1;
}

function rethrowRecordedWorkerBudgetFailure(context: AiExecutionContext): void {
  if (context.workerBudgetFailure === null) {
    return;
  }
  const normalized = normalizeWorkerAiBudgetError(context.workerBudgetFailure);
  if (classifyWorkerAiBudgetError(normalized)) {
    throw normalized;
  }
}

function createWorkerProviderProbeBudget(
  workerBudget: WorkerAiCallBudget
): WorkerAiCallBudget {
  const reportOperationalFailure = workerBudget.onOperationalFailure;
  return {
    ...workerBudget,
    onOperationalFailure(error: unknown): void {
      const normalized = normalizeWorkerAiBudgetError(error);
      if (!classifyWorkerAiBudgetError(normalized)) {
        return;
      }
      reportOperationalFailure?.(normalized);
    }
  };
}

function attachWorkerOperationalFailureReporting(
  workerBudget: WorkerAiCallBudget,
  providerDependencyState: WorkerProviderDependencyState,
  reportOperationalFailure?: ReturnType<typeof createWorkerOperationalStateReporter>,
  persistBudgetPause?: (
    reason: string,
    retryAt: string | null
  ) => Promise<void>
): WorkerAiCallBudget {
  const priorCapacityReporter = workerBudget.onCapacityExhausted;
  const priorReporter = workerBudget.onOperationalFailure;
  return {
    ...workerBudget,
    onCapacityExhausted(nextAvailableAt: string | null): void {
      const reason = `ai_calls_per_hour_exceeded:${workerBudget.maxCallsPerHour}`;
      try {
        reportOperationalFailure?.('paused_budget', reason, nextAvailableAt);
      } catch {
        // Best-effort snapshot work still starts if process-state publication fails.
      }
      try {
        const priorReport = priorCapacityReporter?.(nextAvailableAt);
        void Promise.resolve(priorReport).catch(() => {
          // A prior observer cannot cancel the final admitted provider attempt.
        });
      } catch {
        // A prior observer cannot cancel the final admitted provider attempt.
      }
      try {
        const persistence = persistBudgetPause?.(reason, nextAvailableAt);
        void Promise.resolve(persistence).catch(error => {
          logger.warn('worker.ai_budget.final_capacity_snapshot_failed', {
            module: 'job-runner',
            workerId: workerBudget.workerId,
            statsWorkerId: workerBudget.statsWorkerId,
            retryAt: nextAvailableAt,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      } catch (error) {
        logger.warn('worker.ai_budget.final_capacity_snapshot_failed', {
          module: 'job-runner',
          workerId: workerBudget.workerId,
          statsWorkerId: workerBudget.statsWorkerId,
          retryAt: nextAvailableAt,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    },
    onOperationalFailure(error: unknown): void {
      try {
        priorReporter?.(error);
      } catch {
        // A prior observer cannot replace the provider failure being reported.
      }

      const normalizedWorkerBudgetError = normalizeWorkerAiBudgetError(error);
      const workerBudgetFailure = classifyWorkerAiBudgetError(
        normalizedWorkerBudgetError
      );
      if (workerBudgetFailure) {
        const budgetPaused = workerBudgetFailure.kind === 'budget_paused';
        reportOperationalFailure?.(
          budgetPaused ? 'paused_budget' : 'dependency_failure',
          budgetPaused
            ? 'ai_calls_per_hour_exceeded_during_provider_attempt'
            : 'worker_ai_budget_database_unavailable',
          workerBudgetFailure.retryAt
        );
        return;
      }
      const providerFailure = classifyWorkerProviderRuntimeFailure(error);
      if (!providerFailure) {
        return;
      }
      const reason = `openai_provider_unavailable:${providerFailure.category}`;
      let retryAt: string | null = null;
      try {
        retryAt = getOpenAIProviderRuntimeStatus().nextRetryAt;
      } catch {
        // The shared latch remains authoritative even when diagnostics are unavailable.
      }
      markWorkerProviderDependencyUnavailable(
        providerDependencyState,
        reason,
        retryAt
      );
      reportOperationalFailure?.('dependency_failure', reason, retryAt);
    }
  };
}

export async function recoverSharedWorkerProviderDependency(params: {
  state: WorkerProviderDependencyState;
  workerId: string;
  currentConfigVersion: string | null;
  workerBudget: WorkerAiCallBudget;
}): Promise<WorkerProviderClientState> {
  if (!params.state.recoveryPromise) {
    const recoveryRevision = params.state.revision;
    params.state.recoveryPromise = ensureOpenAIClientForSlot({
      workerId: params.workerId,
      currentClient: null,
      currentConfigVersion: params.currentConfigVersion,
      workerBudget: params.workerBudget,
      forceReload: true
    }).then((result) => {
      if (params.state.revision !== recoveryRevision) {
        return result;
      }
      if (result.client) {
        params.state.unavailable = false;
        params.state.reason = null;
        params.state.retryAt = null;
      } else {
        const providerFailureCategory =
          getOpenAIProviderRuntimeStatus().lastFailureCategory ?? 'unknown';
        params.state.unavailable = true;
        params.state.reason = `openai_provider_unavailable:${providerFailureCategory}`;
        params.state.retryAt = result.pausedUntil;
      }
      return result;
    });
  }

  const recoveryPromise = params.state.recoveryPromise;
  try {
    return await recoveryPromise;
  } finally {
    if (params.state.recoveryPromise === recoveryPromise) {
      params.state.recoveryPromise = null;
    }
  }
}

/**
 * Execute one queued async `/ask` prompt.
 * Purpose: validate queue payloads and return a structured completion/failure outcome for centralized retry handling.
 * Inputs/outputs: accepts the OpenAI client and raw DB payload; returns a structured execution outcome.
 * Edge case behavior: malformed payloads become terminal non-retryable failures.
 */
async function executeQueuedPrompt(
  openai: ReturnType<typeof initOpenAIClient>,
  rawInput: unknown
): Promise<JobExecutionOutcome> {
  const parsedJobInput = parseQueuedAskJobInput(rawInput ?? {});

  //audit Assumption: malformed queue payloads should fail only the affected job; failure risk: poison-job retry loops destabilize the worker; expected invariant: invalid payloads become deterministic terminal failures; handling strategy: validate first and short-circuit with a non-retryable outcome.
  if (!parsedJobInput.ok) {
    return {
      status: 'failed',
      output: null,
      errorMessage: `Invalid job.input: ${parsedJobInput.error}`,
      retryable: false
    };
  }

  const {
    prompt,
    sessionId,
    overrideAuditSafe,
    cognitiveDomain,
    endpointName,
    requestedVerbosity,
    maxWords,
    answerMode,
    debugPipeline,
    strictUserVisibleOutput,
    previewChaosHook
  } = parsedJobInput.value;

  const trinityResult = await runWorkerTrinityPrompt(openai, {
    prompt,
    sessionId,
    overrideAuditSafe,
    cognitiveDomain,
    sourceEndpoint: endpointName,
    requestedVerbosity,
    maxWords,
    answerMode,
    debugPipeline,
    strictUserVisibleOutput,
    previewChaosHook
  });

  return {
    status: 'completed',
    output: buildCompletedQueuedAskOutput(trinityResult, parsedJobInput.value)
  };
}

/**
 * Execute one queued DAG node.
 * Purpose: validate DAG queue payloads and return a structured outcome for centralized retry and completion handling.
 * Inputs/outputs: accepts the OpenAI client and raw DB payload; returns a structured execution outcome.
 * Edge case behavior: invalid payloads are terminal failures, while transient DAG node errors can still be retried centrally.
 */
async function executeQueuedDagNode(
  openai: ReturnType<typeof initOpenAIClient>,
  rawInput: unknown,
  cancellationSignal?: AbortSignal
): Promise<JobExecutionOutcome> {
  const parsedDagJobInput = parseDagNodeJobInput(rawInput ?? {});

  //audit Assumption: invalid DAG queue payloads should fail the current node only; failure risk: corrupted DAG jobs poison the worker loop; expected invariant: bad DAG payloads become terminal failed jobs; handling strategy: validate before any agent lookup or AI call.
  if (!parsedDagJobInput.ok) {
    return {
      status: 'failed',
      output: null,
      errorMessage: `Invalid DAG job.input: ${parsedDagJobInput.error}`,
      retryable: false
    };
  }

  let dagResult: Awaited<ReturnType<typeof runDagNodeJob>>;
  try {
    dagResult = await runDagNodeJob(parsedDagJobInput.value, {
      abortSignal: cancellationSignal,
      runPrompt: createDagNodeRunPromptBridge(openai, {
        runWorkerPrompt: runWorkerTrinityPrompt,
        useGptAccess: isTrinityDagGptAccessEnabled(),
        gptAccessConfig: {
          abortSignal: cancellationSignal
        }
      })
    });
  } catch (error: unknown) {
    if (cancellationSignal?.aborted) {
      return {
        status: 'cancelled',
        output: null,
        errorMessage:
          cancellationSignal.reason instanceof Error
            ? cancellationSignal.reason.message
            : 'DAG node cancellation requested.',
        retryable: false
      };
    }
    throw error;
  }

  if (cancellationSignal?.aborted) {
    return {
      status: 'cancelled',
      output: null,
      errorMessage:
        cancellationSignal.reason instanceof Error
          ? cancellationSignal.reason.message
          : 'DAG node cancellation requested.',
      retryable: false
    };
  }

  //audit Assumption: failed DAG node results may be transient or terminal depending on the message; failure risk: blanket non-retry classification wastes available retry budget; expected invariant: central retry logic receives a normalized hint; handling strategy: classify the node error before returning the failed outcome.
  if (dagResult.status === 'failed') {
    const classifiedFailure = classifyDagNodeFailureForWorkerRetry(dagResult);
    return {
      status: 'failed',
      output: dagResult,
      errorMessage: classifiedFailure.message,
      retryable: classifiedFailure.retryable
    };
  }

  return {
    status: 'completed',
    output: dagResult
  };
}

/**
 * Execute one queued canonical `/gpt/:gptId` request.
 * Purpose: move long-running GPT traffic onto the shared worker queue while preserving the canonical route envelope.
 * Inputs/outputs: accepts raw persisted queue input and returns a structured execution outcome for centralized retry handling.
 * Edge case behavior: malformed payloads are terminal failures, while transient module timeouts remain retryable.
 */
export async function executeQueuedGptRequest(params: {
  jobId: string;
  rawInput: unknown;
  cancellationSignal?: AbortSignal;
  startedAt?: Date | string | number;
  executionPrivacyState?: QueuedGptExecutionPrivacyState;
}): Promise<JobExecutionOutcome> {
  if (hasProtectedBackstageQueuedGptMarker(params.rawInput)) {
    setQueuedGptExecutionPrivacy(params.executionPrivacyState, 'protected');
  } else if (isQueuedGptJobCancellationPrivacySensitive(params.rawInput)) {
    setQueuedGptExecutionPrivacy(params.executionPrivacyState, 'legacy');
  }
  const parsedGptJobInput = parseQueuedGptJobInput(params.rawInput ?? {});

  if (!parsedGptJobInput.ok) {
    return {
      status: 'failed',
      output: null,
      errorMessage: `Invalid GPT job.input: ${parsedGptJobInput.error}`,
      retryable: false
    };
  }

  const protectedBackstageQueuedExecution =
    parsedGptJobInput.value.protectedBackstage !== undefined;
  const protectedExecutionBudget = parsedGptJobInput.value.protectedBackstage
    ? resolveProtectedBackstageWorkerBudget(
        parsedGptJobInput.value.protectedBackstage.action
      )
    : null;
  const protectedOperationDeadlineAt = protectedExecutionBudget
    ? resolveBackstageWorkerOperationDeadlineAt(
        params.startedAt,
        protectedExecutionBudget
      )
    : null;
  const routeStartedAtMs = Date.now();
  const {
    gptId,
    body,
    requestId,
    traceId,
    prompt,
    bypassIntentRouting,
    requestPath,
    executionModeReason,
    routeHint,
    backstageMutationAdmission,
  } = parsedGptJobInput.value;
  const buildProtectedCancellationOutcome = (): JobExecutionOutcome => {
    // Every caller is gated by protectedBackstageQueuedExecution above.
    const protectedBackstage = parsedGptJobInput.value.protectedBackstage!;
    const code = 'BACKSTAGE_ASYNC_EXECUTION_FAILED' as const;
    logger.warn('backstage.protected_result.failed', {
      action: protectedBackstage.action,
      code,
      reason: 'cancelled',
    });
    const output = buildProtectedBackstageCancellationOutput({
      jobId: params.jobId,
      rawInput: params.rawInput,
      action: protectedBackstage.action,
    });
    if (output === null) {
      return {
        status: 'cancelled',
        output: null,
        errorMessage: 'BACKSTAGE_ASYNC_RESULT_PROTECTION_FAILED: Protected Backstage generation result could not be sealed.',
        retryable: false,
      };
    }
    return {
      status: 'cancelled',
      output,
      errorMessage: buildProtectedBackstageFailureMessage(code),
      retryable: false,
    };
  };
  const {
    canonicalQueuedAction,
    isUnprotectedBackstageGeneration,
    legacyBackstageQueuedExecution,
    legacyQueueDrainContextCandidate,
    requestedBackstageAction,
  } = await classifyQueuedBackstageExecution(parsedGptJobInput.value);
  if (legacyQueueDrainContextCandidate) {
    setQueuedGptExecutionPrivacy(params.executionPrivacyState, 'legacy');
  }
  if (isUnprotectedBackstageGeneration && !legacyBackstageQueuedExecution) {
    return {
      status: 'failed',
      output: null,
      errorMessage: 'Protected Backstage generation job payload is required.',
      retryable: false,
    };
  }
  const privateQueuedExecution =
    protectedBackstageQueuedExecution || legacyQueueDrainContextCandidate;
  const canonicalQueuedBody = canonicalQueuedAction
    ? { ...body, action: canonicalQueuedAction }
    : body;
  const hydratedBody = attachQueuedGptExecutionMetadata(
    hydrateQueuedGptBodyPrompt(canonicalQueuedBody, prompt),
    {
      requestPath,
      executionModeReason,
      routeHint
    }
  );
  const latestJob = await getJobById(params.jobId);
  const resolveCancellationReason = async (
    fallbackMessage: string,
    error?: unknown
  ): Promise<string> => {
    if (privateQueuedExecution) {
      return protectedBackstageQueuedExecution
        ? PROTECTED_BACKSTAGE_JOB_CANCELLATION_MESSAGE
        : LEGACY_BACKSTAGE_JOB_CANCELLATION_MESSAGE;
    }

    try {
      const refreshedJob = await getJobById(params.jobId);
      return (
        refreshedJob?.cancel_reason ??
        (error ? resolveErrorMessage(error) : null) ??
        fallbackMessage
      );
    } catch (refreshError) {
      if (!(refreshError instanceof JobRepositoryUnavailableError)) {
        throw refreshError;
      }

      logger.warn('gpt.job.cancellation_reason_repository_unavailable', {
        module: 'worker-gpt',
        jobId: params.jobId
      });
      return (error ? resolveErrorMessage(error) : null) ?? fallbackMessage;
    }
  };
  if (latestJob?.cancel_requested_at) {
    if (legacyBackstageQueuedExecution) {
      setQueuedGptExecutionPrivacy(params.executionPrivacyState, 'legacy');
    }
    if (protectedBackstageQueuedExecution) {
      return buildProtectedCancellationOutcome();
    }
    return {
      status: 'cancelled',
      output: null,
      errorMessage: privateQueuedExecution
        ? protectedBackstageQueuedExecution
          ? PROTECTED_BACKSTAGE_JOB_CANCELLATION_MESSAGE
          : LEGACY_BACKSTAGE_JOB_CANCELLATION_MESSAGE
        : latestJob.cancel_reason ?? 'Job cancellation requested before GPT execution started.',
      retryable: false
    };
  }

  const isGamingSourceIngestion = gptId === GAMING_SOURCE_INGESTION_GPT_ID
    && executionModeReason === GAMING_SOURCE_INGESTION_REASON
    && (requestPath === GAMING_SOURCE_INGESTION_REQUEST_PATH
      || requestPath === GAMING_SOURCE_REFRESH_REQUEST_PATH);
  if (isGamingSourceIngestion) {
    const parsedIngestionBody = parseQueuedGamingSourceIngestionBody(body);
    if (!parsedIngestionBody.ok) {
      return {
        status: 'failed',
        output: null,
        errorMessage: `Invalid gaming-source ingestion job.input: ${parsedIngestionBody.error}`,
        retryable: false
      };
    }
    try {
      const execution = await executeQueuedGamingSourceIngestion(
        params.jobId,
        parsedIngestionBody.value,
        {
          signal: params.cancellationSignal,
          requestId,
          traceId
        }
      );
      if (execution.retryable) {
        return {
          status: 'failed',
          output: execution.output,
          errorMessage: 'All admitted gaming sources failed transiently.',
          retryable: true
        };
      }
      return {
        status: 'completed',
        output: execution.output
      };
    } catch (error: unknown) {
      if (params.cancellationSignal?.aborted) {
        return {
          status: 'cancelled',
          output: null,
          errorMessage: params.cancellationSignal.reason instanceof Error
            ? params.cancellationSignal.reason.message
            : 'Gaming-source ingestion was cancelled.',
          retryable: false
        };
      }
      throw error;
    }
  }
  const routeLogger = logger.child({
    module: 'worker-gpt',
    gptId,
    requestId,
    jobId: params.jobId
  });

  routeLogger.info('gpt.job.started', {
    gptId,
    requestId,
    routeHint: parsedGptJobInput.value.routeHint ?? null,
    executionModeReason: parsedGptJobInput.value.executionModeReason ?? null,
    promptLength: parsedGptJobInput.value.prompt?.length ?? null
  });
  if (protectedExecutionBudget) {
    routeLogger.info('gpt.job.backstage_timeout_plan', {
      action: protectedExecutionBudget.action,
      profile: protectedExecutionBudget.profile,
      totalTimeoutMs: protectedExecutionBudget.totalTimeoutMs,
      operationTimeoutMs: protectedExecutionBudget.operationTimeoutMs,
      modelStageTimeoutMs: protectedExecutionBudget.modelStageTimeoutMs,
      recoveryStageTimeoutMs: protectedExecutionBudget.recoveryStageTimeoutMs,
      orchestrationReserveMs: protectedExecutionBudget.orchestrationReserveMs,
      finalizationReserveMs: protectedExecutionBudget.finalizationReserveMs,
      remainingOperationMs: protectedOperationDeadlineAt === null
        ? null
        : Math.max(0, protectedOperationDeadlineAt - Date.now()),
    });
  }
  if (legacyBackstageQueuedExecution) {
    routeLogger.warn('gpt.job.backstage_legacy_queue_drain', {
      action: requestedBackstageAction ?? canonicalQueuedAction ?? 'automatic',
      producerContract: 'marker_absent',
    });
  }

  if (isQueuedBridgeSmokeJobInput(parsedGptJobInput.value)) {
    const output = buildBridgeSmokeCompletedOutput();
    routeLogger.info('gpt.bridge_smoke.completed', {
      gptId,
      requestId,
      durationMs: Date.now() - routeStartedAtMs,
      bridgeAction: parsedGptJobInput.value.bridgeAction ?? null
    });
    return {
      status: 'completed',
      output
    };
  }

  let envelope;
  try {
    const dispatch = () => routeGptRequest({
        gptId,
        body: hydratedBody,
        requestId,
        traceId: traceId ?? requestId ?? null,
        logger: routeLogger,
        bypassIntentRouting,
        runtimeExecutionMode: 'background',
        parentAbortSignal: getRequestAbortSignal() ?? params.cancellationSignal,
        enforceQueuedBackstageMutationAdmission: true,
        queuedBackstageMutationAdmission: backstageMutationAdmission,
    });
    const dispatchWithQueuedAuthorization = () =>
      parsedGptJobInput.value.protectedBackstage
        ? runWithBackstageProtectedQueuedExecution(
            parsedGptJobInput.value.protectedBackstage.notionEnrichmentAuthorized,
            dispatch
          )
        : legacyQueueDrainContextCandidate
          ? runWithBackstageLegacyQueuedExecution(dispatch)
          : dispatch();
    envelope = protectedExecutionBudget && protectedOperationDeadlineAt !== null
      ? await runWithCooperativeAbortDrain(
          {
            timeoutMs: protectedExecutionBudget.operationTimeoutMs,
            deadlineAt: protectedOperationDeadlineAt,
            requestId,
            parentSignal: params.cancellationSignal,
            abortMessage: 'Protected Backstage worker execution deadline exceeded.',
            scope: 'backstage_worker',
            maxDrainMs: protectedExecutionBudget.abortDrainTimeoutMs,
            onDeadline: () => {
              routeLogger.warn('gpt.job.backstage_deadline_exhausted', {
                action: protectedExecutionBudget.action,
                operationTimeoutMs: protectedExecutionBudget.operationTimeoutMs,
                finalizationReserveMs: protectedExecutionBudget.finalizationReserveMs,
              });
            },
          },
          dispatchWithQueuedAuthorization
        )
      : await dispatchWithQueuedAuthorization();
  } catch (error: unknown) {
    const normalizedWorkerBudgetError = normalizeWorkerAiBudgetError(error);
    if (classifyWorkerAiBudgetError(normalizedWorkerBudgetError)) {
      throw normalizedWorkerBudgetError;
    }
    if (params.cancellationSignal?.aborted && isAbortError(error)) {
      if (protectedBackstageQueuedExecution) {
        return buildProtectedCancellationOutcome();
      }
      return {
        status: 'cancelled',
        output: null,
        errorMessage: await resolveCancellationReason(
          'Job cancellation requested while GPT execution was running.',
          error
        ),
        retryable: false
      };
    }

    if (parsedGptJobInput.value.protectedBackstage) {
      const deadlineExceeded = isCooperativeDeadlineExceededError(
        error,
        'backstage_worker'
      );
      const code = deadlineExceeded
        ? 'BACKSTAGE_ASYNC_TIMEOUT' as const
        : 'BACKSTAGE_ASYNC_EXECUTION_FAILED' as const;
      const output = buildProtectedBackstageFailureEnvelope({
        gptId,
        action: parsedGptJobInput.value.protectedBackstage.action,
        code,
      });
      routeLogger.warn('backstage.protected_result.failed', {
        action: parsedGptJobInput.value.protectedBackstage.action,
        code,
      });
      try {
        return {
          status: 'failed',
          output: protectBackstageQueuedGptJobOutput({
            jobId: params.jobId,
            rawInput: params.rawInput,
            output,
          }),
          errorMessage: deadlineExceeded
            ? 'BACKSTAGE_ASYNC_TIMEOUT: Protected Backstage generation reached its worker deadline.'
            : buildProtectedBackstageFailureMessage(code),
          retryable: false,
        };
      } catch {
        return {
          status: 'failed',
          output: null,
          errorMessage: 'BACKSTAGE_ASYNC_RESULT_PROTECTION_FAILED: Protected Backstage generation result could not be sealed.',
          retryable: false,
        };
      }
    }

    if (legacyBackstageQueuedExecution) {
      const retryable = classifyWorkerExecutionError(error).retryable;
      return {
        status: 'failed',
        output: {
          ok: false,
          error: {
            code: LEGACY_BACKSTAGE_DRAIN_ERROR_CODE,
            message: LEGACY_BACKSTAGE_DRAIN_ERROR_MESSAGE,
          },
        },
        errorMessage:
          `${LEGACY_BACKSTAGE_DRAIN_ERROR_CODE}: ${LEGACY_BACKSTAGE_DRAIN_ERROR_MESSAGE}`,
        retryable,
      };
    }

    throw error;
  }

  const activeAiExecutionContext = getAiExecutionContext();
  if (activeAiExecutionContext) {
    rethrowRecordedWorkerBudgetFailure(activeAiExecutionContext);
  }

  const resolvedLegacyBackstageQueuedExecution =
    legacyQueueDrainContextCandidate
    && envelope._route.module === BACKSTAGE_MODULE_NAME
    && (
      envelope._route.action === 'generateBooking'
      || envelope._route.action === 'generateBookingWithHRC'
    );
  if (resolvedLegacyBackstageQueuedExecution) {
    setQueuedGptExecutionPrivacy(params.executionPrivacyState, 'legacy');
  }
  if (
    resolvedLegacyBackstageQueuedExecution
    && !legacyBackstageQueuedExecution
  ) {
    routeLogger.warn('gpt.job.backstage_legacy_queue_drain', {
      action: envelope._route.action,
      producerContract: 'marker_absent',
    });
  }

  if (!envelope.ok) {
    if (
      !protectedBackstageQueuedExecution &&
      params.cancellationSignal?.aborted &&
      envelope.error.code === 'REQUEST_ABORTED'
    ) {
      return {
        status: 'cancelled',
        output: null,
        errorMessage: await resolveCancellationReason(envelope.error.message),
        retryable: false
      };
    }
    routeLogger.warn('gpt.job.failed', {
      gptId,
      requestId,
      durationMs: Date.now() - routeStartedAtMs,
      errorCode: resolvedLegacyBackstageQueuedExecution
        ? LEGACY_BACKSTAGE_DRAIN_ERROR_CODE
        : envelope.error.code,
      errorMessage: protectedBackstageQueuedExecution || resolvedLegacyBackstageQueuedExecution
        ? protectedBackstageQueuedExecution
          ? 'Protected Backstage generation failed.'
          : LEGACY_BACKSTAGE_DRAIN_ERROR_MESSAGE
        : envelope.error.message
    });
    if (resolvedLegacyBackstageQueuedExecution) {
      return {
        status: 'failed',
        output: {
          ok: false,
          error: {
            code: LEGACY_BACKSTAGE_DRAIN_ERROR_CODE,
            message: LEGACY_BACKSTAGE_DRAIN_ERROR_MESSAGE,
          },
        },
        errorMessage:
          `${LEGACY_BACKSTAGE_DRAIN_ERROR_CODE}: ${LEGACY_BACKSTAGE_DRAIN_ERROR_MESSAGE}`,
        retryable: isQueuedGptDispatchFailureRetryable(envelope.error),
      };
    }
    let failureOutput: unknown = envelope;
    if (parsedGptJobInput.value.protectedBackstage) {
      const code = resolveBackstageProtectedFailureCode(envelope.error.code);
      const protectedFailure = buildProtectedBackstageFailureEnvelope({
        gptId,
        action: parsedGptJobInput.value.protectedBackstage.action,
        code,
      });
      routeLogger.warn('backstage.protected_result.failed', {
        action: parsedGptJobInput.value.protectedBackstage.action,
        code,
      });
      try {
        failureOutput = protectBackstageQueuedGptJobOutput({
          jobId: params.jobId,
          rawInput: params.rawInput,
          output: protectedFailure,
        });
      } catch {
        return {
          status: 'failed',
          output: null,
          errorMessage: 'BACKSTAGE_ASYNC_RESULT_PROTECTION_FAILED: Protected Backstage generation result could not be sealed.',
          retryable: false,
        };
      }
    }
    return {
      status: 'failed',
      output: failureOutput,
      errorMessage: parsedGptJobInput.value.protectedBackstage
        ? buildProtectedBackstageFailureMessage(
            resolveBackstageProtectedFailureCode(envelope.error.code)
          )
        : `${envelope.error.code}: ${envelope.error.message}`,
      retryable: parsedGptJobInput.value.protectedBackstage
        ? false
        : isQueuedGptDispatchFailureRetryable(envelope.error)
    };
  }

  const protectedCompletionProvenance = parsedGptJobInput.value.protectedBackstage
    ? readProtectedBackstageCompletionProvenance(envelope, {
        gptId: 'backstage-booker',
        action: parsedGptJobInput.value.protectedBackstage.action,
      })
    : null;
  if (parsedGptJobInput.value.protectedBackstage && !protectedCompletionProvenance) {
    const code = 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE' as const;
    routeLogger.warn('backstage.protected_result.failed', {
      action: parsedGptJobInput.value.protectedBackstage.action,
      code,
      reason: 'missing_or_invalid_provenance',
    });
    try {
      return {
        status: 'failed',
        output: protectBackstageQueuedGptJobOutput({
          jobId: params.jobId,
          rawInput: params.rawInput,
          output: buildProtectedBackstageFailureEnvelope({
            gptId,
            action: parsedGptJobInput.value.protectedBackstage.action,
            code,
          }),
        }),
        errorMessage: buildProtectedBackstageFailureMessage(code),
        retryable: false,
      };
    } catch {
      return {
        status: 'failed',
        output: null,
        errorMessage: 'BACKSTAGE_ASYNC_RESULT_PROTECTION_FAILED: Protected Backstage generation result could not be sealed.',
        retryable: false,
      };
    }
  }

  routeLogger.info('gpt.job.completed', {
    gptId,
    requestId,
    durationMs: Date.now() - routeStartedAtMs,
    module: envelope._route.module ?? undefined,
    route: envelope._route.route ?? null
  });
  if (protectedCompletionProvenance) {
    routeLogger.info('backstage.protected_result.completed', {
      action: parsedGptJobInput.value.protectedBackstage!.action,
    });
    routeLogger.info('backstage.protected_result.authority_status', {
      authority: protectedCompletionProvenance.authority,
      snapshotStatus: protectedCompletionProvenance.snapshotStatus,
      official: protectedCompletionProvenance.official,
      continuityVerified: protectedCompletionProvenance.continuityVerified,
      fallbackUsed: protectedCompletionProvenance.fallbackUsed,
    });
  }

  const commitOutcomeUnknown = isBackstageCanonCommitOutcomeUnknown(
    backstageMutationAdmission?.action,
    envelope.result
  );
  let completedOutput: unknown = envelope;
  if (parsedGptJobInput.value.protectedBackstage) {
    try {
      completedOutput = protectBackstageQueuedGptJobOutput({
        jobId: params.jobId,
        rawInput: params.rawInput,
        output: envelope,
      });
    } catch {
      return {
        status: 'failed',
        output: null,
        errorMessage: 'BACKSTAGE_ASYNC_RESULT_PROTECTION_FAILED: Protected Backstage generation result could not be sealed.',
        retryable: false,
      };
    }
  }
  return {
    status: 'completed',
    output: completedOutput,
    ...(
      backstageMutationAdmission?.action === 'upsertStoryline'
      || backstageMutationAdmission?.action === 'appendCanonBeat'
        ? { completionWinsLateCancellation: true }
        : {}
    ),
    ...(commitOutcomeUnknown
      ? {
          completionAutonomyState: buildNonReusableGptResultAutonomyState(
            BACKSTAGE_CANON_COMMIT_UNKNOWN_JOB_REUSE_REASON
          )
        }
      : {})
  };
}

export interface JobHeartbeatLoopHandle {
  stop: () => void;
}

export function startHeartbeatLoop(
  autonomyService: WorkerAutonomyService,
  job: Pick<JobData, 'id' | 'claim_generation'>,
  workerId: string,
  onHeartbeat?: (job: Awaited<ReturnType<WorkerAutonomyService['recordHeartbeat']>>) => void,
  onHeartbeatError?: (error: unknown) => void
): JobHeartbeatLoopHandle {
  let stopped = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  const stop = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    if (intervalHandle !== null) {
      clearInterval(intervalHandle);
    }
  };
  const runHeartbeat = createNonOverlappingTaskRunner(
    async () => {
      if (stopped) {
        return;
      }

      const heartbeatJob = await autonomyService.recordHeartbeat(job, {
        source: 'job-heartbeat',
        shouldApplyResult: () => !stopped
      });
      if (!stopped) {
        if (!heartbeatJob) {
          stop();
        }
        onHeartbeat?.(heartbeatJob);
      }
    },
    {
      taskName: 'job-heartbeat',
      onSkip: createOverlapSkipLogger(workerId, 'job-heartbeat')
    }
  );

  intervalHandle = setInterval(() => {
    if (stopped) {
      return;
    }

    void runHeartbeat().catch((error: unknown) => {
      if (!stopped) {
        stop();
        onHeartbeatError?.(error);
      }
      logger.warn(
        'worker.job_heartbeat.failed',
        { module: 'job-runner', workerId, jobId: job.id },
        { errorMessage: resolveErrorMessage(error) },
        error instanceof Error ? error : undefined
      );
    });
  }, resolveJobLeaseHeartbeatIntervalMs(
    autonomyService.getClaimOptions().leaseMs ?? 15_000
  ));

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  return {
    stop
  };
}

function hasLiveClaimFence(
  job: JobData,
  fence: ClaimedJobFence,
  nowMs = Date.now()
): boolean {
  const leaseExpiresAtMs = job.lease_expires_at
    ? new Date(job.lease_expires_at).getTime()
    : Number.NaN;
  return (
    job.status === 'running' &&
    job.last_worker_id === fence.workerId &&
    job.claim_generation === fence.claimGeneration &&
    Number.isFinite(leaseExpiresAtMs) &&
    leaseExpiresAtMs >= nowMs
  );
}

async function finalizeCancellationAfterTerminalCasMiss(params: {
  job: JobData;
  fence: ClaimedJobFence;
  autonomyService: WorkerAutonomyService;
  jobStartedAtMs: number;
  queuedGptCancellationPrivacy?: QueuedGptCancellationPrivacy | null;
  allowPreExecutionInputFallback?: boolean;
}): Promise<boolean> {
  const currentJob = await getJobById(params.job.id);
  if (
    !currentJob ||
    !currentJob.cancel_requested_at ||
    !hasLiveClaimFence(currentJob, params.fence)
  ) {
    return false;
  }

  const cancellationReason =
    currentJob.cancel_reason ??
    'Queue job cancellation won the terminal persistence race.';
  return persistClaimedJobCancellation({
    ...params,
    cancellationReason,
    cancellationRequestedAt: currentJob.cancel_requested_at,
    output: null
  });
}

async function recordCancelledJobCompletion(params: {
  job: JobData;
  autonomyService: WorkerAutonomyService;
  jobStartedAtMs: number;
  cancellationReason: string;
}): Promise<void> {
  await params.autonomyService.markJobCancelled(params.job.id);
  recordWorkerJobDuration({
    jobType: params.job.job_type,
    outcome: 'cancelled',
    durationMs: Date.now() - params.jobStartedAtMs
  });
  if (params.job.job_type !== 'gpt') {
    return;
  }

  const timings = summarizeGptJobTimings({
    created_at: params.job.created_at,
    started_at: new Date(params.jobStartedAtMs),
    completed_at: new Date()
  });
  recordGptJobEvent({
    event: 'cancelled',
    status: 'cancelled',
    retryable: false
  });
  recordGptJobTiming({
    phase: 'execution',
    outcome: 'cancelled',
    durationMs: timings.executionMs
  });
  recordGptJobTiming({
    phase: 'end_to_end',
    outcome: 'cancelled',
    durationMs: timings.endToEndMs
  });
  logger.info('gpt.job.cancelled', {
    jobId: params.job.id,
    errorMessage: params.cancellationReason,
    queueWaitMs: timings.queueWaitMs,
    executionMs: timings.executionMs,
    endToEndMs: timings.endToEndMs
  });
}

export async function persistClaimedJobCancellation(params: {
  job: JobData;
  fence: ClaimedJobFence;
  autonomyService: WorkerAutonomyService;
  jobStartedAtMs: number;
  cancellationReason: string;
  cancellationRequestedAt?: Date | string | null;
  output: unknown;
  queuedGptCancellationPrivacy?: QueuedGptCancellationPrivacy | null;
  allowPreExecutionInputFallback?: boolean;
}): Promise<boolean> {
  const queuedGptCancellationPrivacy = params.queuedGptCancellationPrivacy
    ?? (
      params.job.job_type === 'gpt' && params.allowPreExecutionInputFallback === true
        ? await resolvePreExecutionQueuedGptCancellationPrivacy(params.job.input)
        : null
    );
  const cancellationReason = queuedGptCancellationPrivacy === 'protected'
    ? PROTECTED_BACKSTAGE_JOB_CANCELLATION_MESSAGE
    : queuedGptCancellationPrivacy === 'legacy'
      ? LEGACY_BACKSTAGE_JOB_CANCELLATION_MESSAGE
      : params.cancellationReason;
  let output = params.output;
  if (queuedGptCancellationPrivacy === 'protected' && output == null) {
    const action = resolveProtectedBackstageQueuedGptJobAction(params.job.input);
    if (action) {
      logger.warn('backstage.protected_result.failed', {
        action,
        code: 'BACKSTAGE_ASYNC_EXECUTION_FAILED',
        reason: 'cancelled',
      });
      output = buildProtectedBackstageCancellationOutput({
        jobId: params.job.id,
        rawInput: params.job.input,
        action,
      });
    }
  }
  const cancellationRequestedAt = (() => {
    const persistedRequestedAt =
      params.cancellationRequestedAt ?? params.job.cancel_requested_at;
    if (persistedRequestedAt) {
      const parsedRequestedAt = new Date(persistedRequestedAt);
      if (Number.isFinite(parsedRequestedAt.getTime())) {
        return parsedRequestedAt.toISOString();
      }
    }
    return new Date().toISOString();
  })();
  const terminalJob = await updateClaimedJobTerminal(
    params.job.id,
    'cancelled',
    {
      fence: params.fence,
      output,
      errorMessage: cancellationReason,
      autonomyState: queuedGptCancellationPrivacy
        ? {
            cancellation: {
              requested: true,
              requestedAt: cancellationRequestedAt,
              reason: cancellationReason,
            },
          }
        : undefined,
      metadata: {
        ...(params.job.job_type === 'gpt'
          ? computeGptJobLifecycleDeadlines('cancelled')
          : { idempotencyUntil: null, retentionUntil: null }),
        cancelRequestedAt: new Date().toISOString(),
        cancelReason: cancellationReason
      }
    }
  );
  if (!terminalJob) {
    return false;
  }

  await recordCancelledJobCompletion({
    ...params,
    cancellationReason
  });
  return true;
}

function startWorkerHeartbeatLoop(
  autonomyService: WorkerAutonomyService,
  workerId: string
): WorkerHeartbeatLoopHandle {
  const intervalMs = Math.max(1_000, autonomyService.getHeartbeatIntervalMs());
  const initialJitterMs = computeDeterministicIntervalJitterMs(workerId, intervalMs);
  const runHeartbeat = createNonOverlappingTaskRunner(
    () => autonomyService.recordWorkerHeartbeat({ source: 'worker-heartbeat' }),
    {
      taskName: 'worker-heartbeat',
      onSkip: createOverlapSkipLogger(workerId, 'worker-heartbeat')
    }
  );
  let stopped = false;
  let timeoutHandle: NodeJS.Timeout | null = null;

  const computeNextDelayMs = (initial: boolean): number => {
    if (initial) {
      return initialJitterMs;
    }

    const recommendedDelayMs = Math.max(1_000, autonomyService.getRecommendedWorkerHeartbeatDelayMs());
    const jitterRangeMs = Math.max(1, Math.min(5_000, Math.floor(recommendedDelayMs * 0.2)));
    return recommendedDelayMs + computeDeterministicIntervalJitterMs(workerId, jitterRangeMs);
  };

  const scheduleNextHeartbeat = (initial = false) => {
    if (stopped) {
      return;
    }

    const delayMs = computeNextDelayMs(initial);
    timeoutHandle = setTimeout(() => {
      timeoutHandle = null;
      void executeHeartbeat().finally(() => scheduleNextHeartbeat(false));
    }, delayMs);
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }
  };

  const executeHeartbeat = async () => {
    await runHeartbeat().catch((error: unknown) => {
      logger.warn(
        'worker.heartbeat.failed',
        { module: 'job-runner', workerId },
        { errorMessage: resolveErrorMessage(error) },
        error instanceof Error ? error : undefined
      );
    });
  };

  scheduleNextHeartbeat(true);

  logger.info('worker.heartbeat.stagger_scheduled', {
    module: 'worker',
    workerId,
    intervalMs,
    idleIntervalMs: autonomyService.getRecommendedWorkerHeartbeatDelayMs(),
    jitterMs: initialJitterMs
  });

  return {
    stop() {
      stopped = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
    }
  };
}

function startWatchdogLoop(autonomyService: WorkerAutonomyService): NodeJS.Timeout {
  const intervalMs = Math.max(5_000, autonomyService.getWatchdogIntervalMs());
  const runWatchdog = createNonOverlappingTaskRunner(
    async () => {
      await autonomyService.runWatchdogCycle('watchdog', {
        source: 'watchdog'
      });
    },
    {
      taskName: 'watchdog',
      onSkip: createOverlapSkipLogger(autonomyService.getWorkerId(), 'watchdog')
    }
  );

  const intervalHandle = setInterval(() => {
    void runWatchdog().catch((error: unknown) => {
      logger.warn(
        'worker.watchdog.failed',
        { module: 'job-runner', workerId: autonomyService.getWorkerId() },
        { errorMessage: resolveErrorMessage(error) },
        error instanceof Error ? error : undefined
      );
    });
  }, intervalMs);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  return intervalHandle;
}

function startInspectorLoop(autonomyService: WorkerAutonomyService): NodeJS.Timeout {
  const intervalMs = Math.max(5_000, Number(process.env.JOB_WORKER_INSPECTOR_MS || 30_000));
  const runInspector = createNonOverlappingTaskRunner(
    async () => {
      await autonomyService.inspect('scheduled', [], {
        source: 'inspector'
      });
    },
    {
      taskName: 'inspector',
      onSkip: createOverlapSkipLogger(autonomyService.getWorkerId(), 'inspector')
    }
  );

  const intervalHandle = setInterval(() => {
    void runInspector().catch((error: unknown) => {
      logger.warn(
        'worker.inspector.failed',
        { module: 'job-runner', workerId: autonomyService.getWorkerId() },
        { errorMessage: resolveErrorMessage(error) },
        error instanceof Error ? error : undefined
      );
    });
  }, intervalMs);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  return intervalHandle;
}

function buildAutonomyServiceForSlot(
  slotDefinition: JobRunnerSlotDefinition
): WorkerAutonomyService {
  return new WorkerAutonomyService(
    getWorkerAutonomySettings({
      workerId: slotDefinition.workerId,
      statsWorkerId: slotDefinition.statsWorkerId
    })
  );
}

async function pauseClaimIfBudgetDisallowed(
  autonomyService: WorkerAutonomyService,
  slotDefinition: JobRunnerSlotDefinition,
  reportOperationalState: ReturnType<typeof createWorkerOperationalStateReporter>,
  suppliedDecision?: Awaited<ReturnType<WorkerAutonomyService['evaluateBudgetsBeforeClaim']>>
): Promise<boolean> {
  const decision = suppliedDecision ?? await autonomyService.evaluateBudgetsBeforeClaim();
  if (decision.allowed) {
    reportOperationalState('accepting_claims');
    return false;
  }

  autonomyService.recordClaimResult('budget_paused');
  reportOperationalState(
    decision.claimAcceptance === 'paused_rss' ? 'paused_rss' : 'paused_budget',
    decision.reason,
    decision.retryAt
  );
  logger.warn(
    decision.claimAcceptance === 'paused_rss'
      ? 'worker.claim.paused_rss'
      : 'worker.claim.paused_budget',
    {
      module: 'job-runner',
      workerId: slotDefinition.workerId,
      reason: decision.reason,
      sleepMs: decision.sleepMs,
      retryAt: decision.retryAt
    }
  );
  await sleepUntilWorkerProcessSignal(decision.sleepMs);
  return true;
}

/**
 * Run one queue-consumer slot inside the Railway worker process.
 * Purpose: allow one deployed worker container to claim and execute multiple queue jobs concurrently.
 * Inputs/outputs: accepts one slot definition, shared runtime settings, optional
 * prebuilt autonomy and partition-sync executors, and a dispatcher-ready
 * callback; does not resolve during normal operation.
 * Edge case behavior: unsupported or invalid job payloads fail deterministically per slot without stopping sibling slots.
 */
export async function runWorkerConsumerSlot(
  slotDefinition: JobRunnerSlotDefinition,
  runtimeSettings: JobRunnerRuntimeSettings,
  autonomyService: WorkerAutonomyService = buildAutonomyServiceForSlot(slotDefinition),
  onDispatcherReady: () => void = () => undefined,
  partitionSyncExecutor?: BackstageNotionPartitionSyncJobExecutor,
  providerDependencyState: WorkerProviderDependencyState = createWorkerProviderDependencyState(),
  operationalStateReporter?: ReturnType<typeof createWorkerOperationalStateReporter>
): Promise<void> {
  let openai: OpenAIClient | null = null;
  let providerConfigVersion: string | null = null;
  let lastProviderPauseLogAtMs = 0;
  let lastNoJobLogAtMs = 0;
  let lastClaimAttemptLogAtMs = 0;
  let consecutiveIdleClaims = 0;
  let dispatcherReadinessReported = false;
  const reportOperationalState = operationalStateReporter
    ?? createWorkerOperationalStateReporter(slotDefinition.workerId);
  const workerAiCallBudget = attachWorkerOperationalFailureReporting(
    autonomyService.getWorkerAiCallBudget(),
    providerDependencyState,
    reportOperationalState,
    async (reason, retryAt) => autonomyService.setClaimAcceptanceState(
      'paused_budget',
      { reason, retryAt }
    )
  );
  const applyWorkerAiBudgetFailureState = async (error: unknown) => {
    const workerAiBudgetError = classifyWorkerAiBudgetError(
      normalizeWorkerAiBudgetError(error)
    );
    if (!workerAiBudgetError) {
      return null;
    }

    const budgetPaused = workerAiBudgetError.kind === 'budget_paused';
    const reason = budgetPaused
      ? 'ai_calls_per_hour_exceeded_during_provider_attempt'
      : 'worker_ai_budget_database_unavailable';
    const state = budgetPaused ? 'paused_budget' : 'dependency_failure';
    const delayMs = budgetPaused
      ? resolveProviderPauseMs(workerAiBudgetError.retryAt, 60_000)
      : Math.max(runtimeSettings.idleBackoffMs, 5_000);
    reportOperationalState(state, reason, workerAiBudgetError.retryAt);
    await autonomyService.setClaimAcceptanceState(state, {
      reason,
      retryAt: workerAiBudgetError.retryAt
    });
    return {
      budgetPaused,
      delayMs,
      reason,
      retryAt: workerAiBudgetError.retryAt
    };
  };

  logger.info('worker.slot.started', {
    module: 'job-runner',
    workerId: slotDefinition.workerId,
    slotNumber: slotDefinition.slotNumber,
    concurrency: runtimeSettings.concurrency
  });
  logger.info('[worker-runtime] polling loop started', {
    module: 'job-runner',
    workerId: slotDefinition.workerId,
    slotNumber: slotDefinition.slotNumber,
    activeListeners: runtimeSettings.concurrency,
    pollMs: runtimeSettings.pollMs,
    idleBackoffMs: runtimeSettings.idleBackoffMs
  });
  await autonomyService.markDispatcherStarted(runtimeSettings.concurrency);
  const workerHeartbeatHandle = startWorkerHeartbeatLoop(autonomyService, slotDefinition.workerId);

  try {
    while (!isWorkerProcessShutdownRequested()) {
      try {
        if (providerDependencyState.unavailable) {
          reportOperationalState(
            'dependency_failure',
            providerDependencyState.reason ?? 'openai_provider_unavailable:unknown',
            providerDependencyState.retryAt
          );
          await autonomyService.setClaimAcceptanceState('dependency_failure', {
            reason: providerDependencyState.reason ?? 'openai_provider_unavailable:unknown',
            retryAt: providerDependencyState.retryAt
          });
          if (!dispatcherReadinessReported) {
            onDispatcherReady();
            dispatcherReadinessReported = true;
          }

          let recoveryClientState: WorkerProviderClientState;
          try {
            recoveryClientState = await recoverSharedWorkerProviderDependency({
              state: providerDependencyState,
              workerId: slotDefinition.workerId,
              currentConfigVersion: providerConfigVersion,
              workerBudget: workerAiCallBudget
            });
          } catch (error) {
            const budgetFailure = await applyWorkerAiBudgetFailureState(error);
            if (!budgetFailure) {
              throw error;
            }
            await sleepUntilWorkerProcessSignal(budgetFailure.delayMs);
            continue;
          }
          providerConfigVersion = recoveryClientState.configVersion;
          if (recoveryClientState.providerRecovered) {
            await autonomyService.recordProviderCircuitBreakerReset({
              providerFailureCategory: recoveryClientState.providerRecoveryCategory,
              providerNextRetryAt: recoveryClientState.providerRecoveryNextRetryAt,
              source: 'job-runner'
            });
          }
          if (providerDependencyState.unavailable || !recoveryClientState.client) {
            openai = null;
            const reason =
              providerDependencyState.reason ?? 'openai_provider_unavailable:unknown';
            reportOperationalState(
              'dependency_failure',
              reason,
              providerDependencyState.retryAt
            );
            await autonomyService.setClaimAcceptanceState('dependency_failure', {
              reason,
              retryAt: providerDependencyState.retryAt
            });
            await sleepUntilWorkerProcessSignal(resolveProviderPauseMs(
              providerDependencyState.retryAt,
              runtimeSettings.idleBackoffMs
            ));
            continue;
          }
          openai = recoveryClientState.client;
        }

        const budgetDecision = await autonomyService.evaluateBudgetsBeforeClaim();
        reportOperationalState(
          budgetDecision.allowed
            ? 'accepting_claims'
            : budgetDecision.claimAcceptance === 'paused_rss'
              ? 'paused_rss'
              : 'paused_budget',
          budgetDecision.reason,
          budgetDecision.retryAt
        );
        if (!dispatcherReadinessReported) {
          onDispatcherReady();
          dispatcherReadinessReported = true;
        }
        if (await pauseClaimIfBudgetDisallowed(
          autonomyService,
          slotDefinition,
          reportOperationalState,
          budgetDecision
        )) {
          continue;
        }

      const claimLogNowMs = Date.now();
      autonomyService.recordClaimAttempt();
      if (claimLogNowMs - lastClaimAttemptLogAtMs >= 30_000) {
        logger.info('[worker-runtime] claim attempt', {
          module: 'job-runner',
          workerId: slotDefinition.workerId,
          leaseMs: autonomyService.getClaimOptions().leaseMs ?? null
        });
        lastClaimAttemptLogAtMs = claimLogNowMs;
      } else {
        logger.debug('[worker-runtime] claim attempt', {
          module: 'job-runner',
          workerId: slotDefinition.workerId
        });
      }

      const { job, budgetAdmission } = await postgresQueueSchedulerAdapter.claimNext(
        autonomyService.getClaimOptions()
      );

      if (!job && budgetAdmission && !budgetAdmission.allowed) {
        const reason = budgetAdmission.kind === 'job_claim'
          ? `jobs_per_hour_exceeded:${budgetAdmission.used}`
          : `ai_calls_per_hour_exceeded:${budgetAdmission.used}`;
        const sleepMs = Math.min(
          60_000,
          resolveProviderPauseMs(budgetAdmission.nextAvailableAt, 1_000)
        );
        autonomyService.recordClaimResult('budget_paused');
        await autonomyService.setClaimAcceptanceState('paused_budget', {
          reason,
          retryAt: budgetAdmission.nextAvailableAt
        });
        reportOperationalState(
          'paused_budget',
          reason,
          budgetAdmission.nextAvailableAt
        );
        logger.warn('worker.claim.atomic_budget_paused', {
          module: 'job-runner',
          workerId: slotDefinition.workerId,
          statsWorkerId: budgetAdmission.statsWorkerId,
          budgetKind: budgetAdmission.kind,
          used: budgetAdmission.used,
          limit: budgetAdmission.limit,
          retryAt: budgetAdmission.nextAvailableAt,
          sleepMs
        });
        await sleepUntilWorkerProcessSignal(sleepMs);
        continue;
      }

      if (!job) {
        consecutiveIdleClaims += 1;
        autonomyService.recordClaimResult('no_job_available');
        const idleSleepMs = resolveJobRunnerIdleBackoffDelayMs({
          baseIdleBackoffMs: runtimeSettings.idleBackoffMs,
          workerId: slotDefinition.workerId,
          idleStreak: consecutiveIdleClaims
        });
        const nowMs = Date.now();
        if (nowMs - lastNoJobLogAtMs >= 30_000) {
          logger.info('[worker-runtime] no job available', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            idleBackoffMs: idleSleepMs,
            baseIdleBackoffMs: runtimeSettings.idleBackoffMs,
            idleStreak: consecutiveIdleClaims
          });
          lastNoJobLogAtMs = nowMs;
        } else {
          logger.debug('[worker-runtime] no job available', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            idleBackoffMs: idleSleepMs,
            idleStreak: consecutiveIdleClaims
          });
        }
        await autonomyService.markIdle();
        await sleepUntilWorkerProcessSignal(idleSleepMs);
        continue;
      }

      if (budgetAdmission?.allowed && budgetAdmission.remaining === 0) {
        const reason = `jobs_per_hour_exceeded:${budgetAdmission.used}`;
        reportOperationalState(
          'paused_budget',
          reason,
          budgetAdmission.nextAvailableAt
        );
        try {
          const persistence = autonomyService.setClaimAcceptanceState('paused_budget', {
            reason,
            retryAt: budgetAdmission.nextAvailableAt
          });
          void Promise.resolve(persistence).catch(error => {
            logger.warn('worker.claim.final_budget_snapshot_failed', {
              module: 'job-runner',
              workerId: slotDefinition.workerId,
              statsWorkerId: budgetAdmission.statsWorkerId,
              budgetKind: budgetAdmission.kind,
              used: budgetAdmission.used,
              limit: budgetAdmission.limit,
              retryAt: budgetAdmission.nextAvailableAt,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        } catch (error) {
          logger.warn('worker.claim.final_budget_snapshot_failed', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            statsWorkerId: budgetAdmission.statsWorkerId,
            budgetKind: budgetAdmission.kind,
            used: budgetAdmission.used,
            limit: budgetAdmission.limit,
            retryAt: budgetAdmission.nextAvailableAt,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        logger.warn('worker.claim.atomic_budget_exhausted', {
          module: 'job-runner',
          workerId: slotDefinition.workerId,
          statsWorkerId: budgetAdmission.statsWorkerId,
          budgetKind: budgetAdmission.kind,
          used: budgetAdmission.used,
          limit: budgetAdmission.limit,
          retryAt: budgetAdmission.nextAvailableAt
        });
      }

      const claimFence = createClaimedJobFence(
        slotDefinition.workerId,
        job.claim_generation
      );
      consecutiveIdleClaims = 0;
      autonomyService.recordClaimResult('claimed_job');
      logger.info('[worker-runtime] claimed job', {
        module: 'job-runner',
        workerId: slotDefinition.workerId,
        jobId: job.id,
        jobType: job.job_type,
        retryCount: job.retry_count ?? 0,
        maxRetries: job.max_retries ?? null
      });
      let initialHeartbeatJob: Awaited<
        ReturnType<WorkerAutonomyService['recordHeartbeat']>
      >;
      try {
        initialHeartbeatJob = await autonomyService.recordHeartbeat(job, {
          source: 'job-start-heartbeat',
          shouldApplyResult: () => false
        });
      } catch (error: unknown) {
        logger.warn(
          'worker.job_initial_heartbeat.failed',
          {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            jobId: job.id
          },
          { errorMessage: resolveErrorMessage(error) },
          error instanceof Error ? error : undefined
        );
        await autonomyService.markJobLeaseLost(
          job.id,
          'Initial heartbeat failed before provider initialization.'
        );
        continue;
      }
      if (!initialHeartbeatJob) {
        await autonomyService.markJobLeaseLost(
          job.id,
          'Initial heartbeat fence was lost before provider initialization.'
        );
        continue;
      }
      await autonomyService.markJobStarted(job);
      void recordJobEvent({
        jobId: job.id,
        eventType: 'job.started',
        traceId: job.correlation_id ?? null,
        workerId: slotDefinition.workerId,
        metadata: {
          jobType: job.job_type,
          claimGeneration: job.claim_generation,
          retryCount: job.retry_count ?? 0,
          maxRetries: job.max_retries ?? null
        }
      });
      const jobCancellationController = new AbortController();
      let jobAbortState: ClaimedJobAbortState = {
        cause: null,
        durableCancellationReason: null
      };
      const abortClaimedJob = (
        cause: ClaimedJobAbortCause,
        message: string
      ): void => {
        jobAbortState = advanceClaimedJobAbortState(
          jobAbortState,
          cause,
          message
        );
        if (!jobCancellationController.signal.aborted) {
          jobCancellationController.abort(createAbortError(message));
        }
      };
      const abortJobOnProcessShutdown = () => {
        abortClaimedJob(
          'process_shutdown',
          'Worker process shutdown requested while a queue job was running.'
        );
      };
      let heartbeatHandle: JobHeartbeatLoopHandle | null = null;
      const jobStartedAtMs = Date.now();
      let jobLeaseLost = false;
      let jobExecutionStarted = false;
      const queuedGptExecutionPrivacyState: QueuedGptExecutionPrivacyState = {
        cancellationPrivacy: null,
      };

      try {
        if (workerProcessShutdownController.signal.aborted) {
          abortJobOnProcessShutdown();
        } else {
          workerProcessShutdownController.signal.addEventListener(
            'abort',
            abortJobOnProcessShutdown,
            { once: true }
          );
        }
        if (job.cancel_requested_at || initialHeartbeatJob.cancel_requested_at) {
          abortClaimedJob(
            'durable_cancellation',
            initialHeartbeatJob.cancel_reason
              ?? job.cancel_reason
              ?? 'Queue job cancellation requested before execution.'
          );
        }
        heartbeatHandle = startHeartbeatLoop(
          autonomyService,
          job,
          slotDefinition.workerId,
          (updatedJob) => {
            if (!updatedJob) {
              jobLeaseLost = true;
              abortClaimedJob(
                'lease_lost',
                'Queue job lease lost or job completed elsewhere.'
              );
              return;
            }

            if (updatedJob.cancel_requested_at) {
              abortClaimedJob(
                'durable_cancellation',
                updatedJob.cancel_reason ?? 'Queue job cancellation requested.'
              );
            }
          },
          () => {
            jobLeaseLost = true;
            abortClaimedJob(
              'lease_lost',
              'Queue job lease renewal failed; local execution stopped for recovery.'
            );
          }
        );
        if (jobLeaseLost) {
          await autonomyService.markJobLeaseLost(
            job.id,
            'Job lease lost during provider initialization.'
          );
          continue;
        }
        if (jobCancellationController.signal.aborted) {
          if (!shouldPersistClaimedJobCancellation(jobAbortState.cause)) {
            await autonomyService.markJobLeaseLost(
              job.id,
              'Worker stopped local execution before provider initialization; the live claim was left for lease recovery.'
            );
            continue;
          }
          const cancellationReason =
            jobAbortState.durableCancellationReason ??
            (jobCancellationController.signal.reason instanceof Error
              ? jobCancellationController.signal.reason.message
              : 'Queue job cancellation requested before provider initialization.');
          if (!await persistClaimedJobCancellation({
            job,
            fence: claimFence,
            autonomyService,
            jobStartedAtMs,
            cancellationReason,
            output: null,
            allowPreExecutionInputFallback: true,
          })) {
            await autonomyService.markJobLeaseLost(
              job.id,
              'Cancellation fence was lost before provider initialization.'
            );
          }
          continue;
        }

        let dedicatedPartitionSyncOutcome: JobExecutionOutcome | null = null;
        let protectedBackstageOperationDeadlineAt: number | null = null;
        if (job.job_type === BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE) {
          jobExecutionStarted = true;
          const partitionSyncAiExecutionContext = createAiExecutionContext({
            sourceType: 'job',
            sourceName: job.job_type,
            requestId: job.correlation_id ?? job.id,
            traceId: job.correlation_id ?? undefined,
            jobId: job.id,
            budget: {
              maxCalls: BACKSTAGE_NOTION_PARTITION_SYNC_MAX_AI_CALLS,
            },
            workerBudget: workerAiCallBudget,
          });
          dedicatedPartitionSyncOutcome = await runWithAiExecutionContext(
            partitionSyncAiExecutionContext,
            async () => runWithRequestAbortContext(
              {
                requestId: job.correlation_id ?? job.id,
                controller: jobCancellationController,
                signal: jobCancellationController.signal,
                deadlineAt: Number.MAX_SAFE_INTEGER,
                timeoutMs: Number.MAX_SAFE_INTEGER,
              },
              async () => partitionSyncExecutor
                ? partitionSyncExecutor({
                    rawInput: job.input ?? {},
                    cancellationSignal: jobCancellationController.signal,
                  })
                : {
                    status: 'failed',
                    output: null,
                    errorMessage:
                      'Partition synchronization worker executor is unavailable.',
                    retryable: false,
                  } satisfies JobExecutionOutcome
            )
          );
          rethrowRecordedWorkerBudgetFailure(partitionSyncAiExecutionContext);
          const partitionSyncAiUsageSummary = summarizeAiExecutionContext(
            partitionSyncAiExecutionContext
          );
          if (
            partitionSyncAiUsageSummary
            && partitionSyncAiUsageSummary.totals.calls > 0
          ) {
            logger.info('worker.ai.summary', {
              module: 'job-runner',
              workerId: slotDefinition.workerId,
              jobId: job.id,
              jobType: job.job_type,
            }, { aiUsage: partitionSyncAiUsageSummary });
          }
        } else {
        const ensuredClientState = await ensureOpenAIClientForSlot({
          workerId: slotDefinition.workerId,
          currentClient: openai,
          currentConfigVersion: providerConfigVersion,
          workerBudget: workerAiCallBudget
        });
        openai = ensuredClientState.client;
        providerConfigVersion = ensuredClientState.configVersion;
        if (ensuredClientState.providerRecovered) {
          await autonomyService.recordProviderCircuitBreakerReset({
            providerFailureCategory: ensuredClientState.providerRecoveryCategory,
            providerNextRetryAt: ensuredClientState.providerRecoveryNextRetryAt,
            source: 'job-runner'
          });
        }

        const protectedBackstageAction = job.job_type === 'gpt'
          ? resolveProtectedBackstageQueuedGptJobAction(job.input ?? {})
          : null;
        const protectedBackstageBudget = protectedBackstageAction
          ? resolveProtectedBackstageWorkerBudget(protectedBackstageAction)
          : null;
        protectedBackstageOperationDeadlineAt = protectedBackstageBudget
          ? resolveBackstageWorkerOperationDeadlineAt(
              job.started_at ?? job.created_at,
              protectedBackstageBudget
            )
          : null;

        if (jobLeaseLost) {
          await autonomyService.markJobLeaseLost(
            job.id,
            'Job lease lost during provider initialization.'
          );
          continue;
        }
        if (jobCancellationController.signal.aborted) {
          if (!shouldPersistClaimedJobCancellation(jobAbortState.cause)) {
            await autonomyService.markJobLeaseLost(
              job.id,
              'Worker stopped local execution during provider initialization; the live claim was left for lease recovery.'
            );
            continue;
          }
          const cancellationReason =
            jobAbortState.durableCancellationReason ??
            (jobCancellationController.signal.reason instanceof Error
              ? jobCancellationController.signal.reason.message
              : 'Queue job cancellation requested during provider initialization.');
          if (!await persistClaimedJobCancellation({
            job,
            fence: claimFence,
            autonomyService,
            jobStartedAtMs,
            cancellationReason,
            output: null,
            allowPreExecutionInputFallback: true,
          })) {
            await autonomyService.markJobLeaseLost(
              job.id,
              'Cancellation fence was lost during provider initialization.'
            );
          }
          continue;
        }

        if (!openai) {
          const providerFailureCategory =
            getOpenAIProviderRuntimeStatus().lastFailureCategory ?? 'unknown';
          const dependencyReason = `openai_provider_unavailable:${providerFailureCategory}`;
          markWorkerProviderDependencyUnavailable(
            providerDependencyState,
            dependencyReason,
            ensuredClientState.pausedUntil
          );
          reportOperationalState(
            'dependency_failure',
            dependencyReason,
            ensuredClientState.pausedUntil
          );
          await autonomyService.setClaimAcceptanceState('dependency_failure', {
            reason: dependencyReason,
            retryAt: ensuredClientState.pausedUntil
          });
          const delayMs = resolveProviderPauseMs(
            ensuredClientState.pausedUntil,
            runtimeSettings.idleBackoffMs
          );
          const deadlineBoundedDelayMs =
            protectedBackstageOperationDeadlineAt === null
              ? delayMs
              : resolveBackstageProviderDeferralDelayMs({
                  deadlineAt: protectedBackstageOperationDeadlineAt,
                  requestedDelayMs: delayMs,
                });
          if (deadlineBoundedDelayMs === null) {
            logger.warn('gpt.job.backstage_deadline_prevents_provider_deferral', {
              module: 'job-runner',
              workerId: slotDefinition.workerId,
              jobId: job.id,
              action: protectedBackstageAction,
            });
          } else {
            const nowMs = Date.now();
            if (nowMs - lastProviderPauseLogAtMs >= 10_000) {
              logger.warn('[worker-runtime] circuit open: execution blocked, polling continues', {
                module: 'job-runner',
                workerId: slotDefinition.workerId,
                jobId: job.id,
                jobType: job.job_type,
                nextRetryAt: ensuredClientState.pausedUntil ?? null,
                providerFailureCategory: getOpenAIProviderRuntimeStatus().lastFailureCategory,
                delayMs: deadlineBoundedDelayMs,
                deadlineGuarded:
                  protectedBackstageOperationDeadlineAt !== null,
                pollingContinues: true
              });
              lastProviderPauseLogAtMs = nowMs;
            }
            const deferralResult = await autonomyService.deferJobForProviderRecovery(job, {
              delayMs: deadlineBoundedDelayMs,
              errorMessage: 'OpenAI provider unavailable before job execution; job deferred until provider recovery.',
              providerNextRetryAt: ensuredClientState.pausedUntil,
              providerFailureCategory: getOpenAIProviderRuntimeStatus().lastFailureCategory
            });
            if (deferralResult.action === 'lease_lost') {
              await finalizeCancellationAfterTerminalCasMiss({
                job,
                fence: claimFence,
                autonomyService,
                jobStartedAtMs,
                allowPreExecutionInputFallback: true,
              });
            }
            await sleepUntilWorkerProcessSignal(runtimeSettings.pollMs);
            continue;
          }
        }
        }
        const queueWaitMs = Math.max(
          0,
          jobStartedAtMs - new Date(job.created_at as string | Date).getTime()
        );
        if (job.job_type === 'gpt') {
          recordGptJobTiming({
            phase: 'queue_wait',
            outcome: 'claimed',
            durationMs: queueWaitMs
          });
        }

        let outcome: JobExecutionOutcome;
        if (dedicatedPartitionSyncOutcome) {
          outcome = dedicatedPartitionSyncOutcome;
        } else {
        const aiExecutionContext = createAiExecutionContext({
          sourceType: 'job',
          sourceName: job.job_type,
          requestId: job.correlation_id ?? job.id,
          traceId: job.correlation_id ?? undefined,
          jobId: job.id,
          budget: {
            maxCalls: 24
          },
          workerBudget: workerAiCallBudget
        });
        outcome = await runWithAiExecutionContext(aiExecutionContext, async () =>
          runWithRequestAbortContext(
            {
              requestId: job.correlation_id ?? job.id,
              controller: jobCancellationController,
              signal: jobCancellationController.signal,
              deadlineAt: Number.MAX_SAFE_INTEGER,
              timeoutMs: Number.MAX_SAFE_INTEGER
            },
            async () => {
              //audit Assumption: the shared queue currently supports async ask jobs and DAG node jobs only; failure risk: unknown job types spin indefinitely after claim; expected invariant: unsupported job types fail deterministically; handling strategy: branch explicitly per supported job type and centralize failure handling.
              if (
                job.job_type === 'gpt'
                && protectedBackstageOperationDeadlineAt !== null
              ) {
                jobExecutionStarted = true;
                return executeQueuedGptRequest({
                  jobId: job.id,
                  rawInput: job.input ?? {},
                  cancellationSignal: jobCancellationController.signal,
                  startedAt: job.started_at ?? job.created_at,
                  executionPrivacyState: queuedGptExecutionPrivacyState,
                });
              }
              if (!openai) {
                return {
                  status: 'failed',
                  output: null,
                  errorMessage: 'OpenAI provider unavailable; job execution deferred until provider recovery.',
                  retryable: true
                } satisfies JobExecutionOutcome;
              }
              if (job.job_type === 'ask') {
                return executeQueuedPrompt(openai, job.input ?? {});
              }
              if (job.job_type === 'dag-node') {
                return executeQueuedDagNode(
                  openai,
                  job.input ?? {},
                  jobCancellationController.signal
                );
              }
              if (job.job_type === 'gpt') {
                jobExecutionStarted = true;
                return executeQueuedGptRequest({
                  jobId: job.id,
                  rawInput: job.input ?? {},
                  cancellationSignal: jobCancellationController.signal,
                  startedAt: job.started_at ?? job.created_at,
                  executionPrivacyState: queuedGptExecutionPrivacyState,
                });
              }
              return {
                status: 'failed',
                output: null,
                errorMessage: `Unsupported job_type: ${job.job_type}`,
                retryable: false
              } satisfies JobExecutionOutcome;
            }
          )
        );
        rethrowRecordedWorkerBudgetFailure(aiExecutionContext);
        const aiUsageSummary = summarizeAiExecutionContext(aiExecutionContext);
        if (aiUsageSummary && aiUsageSummary.totals.calls > 0) {
          logger.info('worker.ai.summary', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            jobId: job.id,
            jobType: job.job_type
          }, { aiUsage: aiUsageSummary });
        }
        }

        if (jobLeaseLost) {
          logger.warn('worker.job_lease_lost.local_stop', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            jobId: job.id,
            jobType: job.job_type,
            durationMs: Date.now() - jobStartedAtMs
          });
          await autonomyService.markJobLeaseLost(
            job.id,
            'Job lease lost or job completed elsewhere.'
          );
          continue;
        }

        const latestJobBeforeTerminal = await getJobById(job.id);
        if (
          !latestJobBeforeTerminal ||
          latestJobBeforeTerminal.status !== 'running' ||
          latestJobBeforeTerminal.last_worker_id !== claimFence.workerId ||
          latestJobBeforeTerminal.claim_generation !== claimFence.claimGeneration
        ) {
          jobLeaseLost = true;
          abortClaimedJob(
            'lease_lost',
            'Queue job lease lost before terminal persistence.'
          );
          await autonomyService.markJobLeaseLost(
            job.id,
            'Queue job lease lost before terminal persistence.'
          );
          continue;
        }
        if (latestJobBeforeTerminal.cancel_requested_at) {
          abortClaimedJob(
            'durable_cancellation',
            latestJobBeforeTerminal.cancel_reason ??
              'Queue job cancellation requested before terminal persistence.'
          );
        }
        const completedAdmittedCanonMutation =
          outcome.status === 'completed'
          && outcome.completionWinsLateCancellation === true;
        if (
          jobCancellationController.signal.aborted
          && !completedAdmittedCanonMutation
        ) {
          if (!shouldPersistClaimedJobCancellation(jobAbortState.cause)) {
            await autonomyService.markJobLeaseLost(
              job.id,
              'Worker stopped local execution before terminal persistence; the live claim was left for lease recovery.'
            );
            continue;
          }
          outcome = {
            status: 'cancelled',
            output: null,
            errorMessage:
              jobAbortState.durableCancellationReason ??
              (jobCancellationController.signal.reason instanceof Error
                ? jobCancellationController.signal.reason.message
                : 'Queue job cancellation requested.'),
            retryable: false
          };
        }

      if (outcome.status === 'completed') {
        const lifecycleDeadlines =
          job.job_type === 'gpt'
            ? computeGptJobLifecycleDeadlines('completed')
            : { idempotencyUntil: null, retentionUntil: null };
        const terminalJob = await updateClaimedJobTerminal(
          job.id,
          'completed',
          {
            fence: claimFence,
            output: outcome.output,
            errorMessage: null,
            autonomyState: outcome.completionAutonomyState,
            metadata: lifecycleDeadlines,
            allowCompletionAfterCancellationRequest:
              outcome.completionWinsLateCancellation === true
          }
        );
        if (!terminalJob) {
          if (
            outcome.completionWinsLateCancellation !== true
            && await finalizeCancellationAfterTerminalCasMiss({
              job,
              fence: claimFence,
              autonomyService,
              jobStartedAtMs,
              queuedGptCancellationPrivacy:
                queuedGptExecutionPrivacyState.cancellationPrivacy,
            })
          ) {
            continue;
          }
          await autonomyService.markJobLeaseLost(
            job.id,
            'Completion fence was lost before the job could be finalized.'
          );
          continue;
        }

        await autonomyService.markJobCompleted(job.id);
        recordWorkerJobDuration({
          jobType: job.job_type,
          outcome: 'completed',
          durationMs: Date.now() - jobStartedAtMs,
        });
        if (job.job_type === 'gpt') {
          const timings = summarizeGptJobTimings({
            created_at: job.created_at,
            started_at: new Date(jobStartedAtMs),
            completed_at: new Date()
          });
          recordGptJobEvent({
            event: 'completed',
            status: 'completed',
            retryable: false
          });
          recordGptJobTiming({
            phase: 'execution',
            outcome: 'completed',
            durationMs: timings.executionMs
          });
          recordGptJobTiming({
            phase: 'end_to_end',
            outcome: 'completed',
            durationMs: timings.endToEndMs
          });
          logger.info('gpt.job.completed_timing', {
            jobId: job.id,
            queueWaitMs: timings.queueWaitMs,
            executionMs: timings.executionMs,
            endToEndMs: timings.endToEndMs
          });
        }
      } else if (outcome.status === 'cancelled') {
        if (!shouldPersistClaimedJobCancellation(jobAbortState.cause)) {
          await autonomyService.markJobLeaseLost(
            job.id,
            'Cancellation outcome lacked a durable database request; the live claim was left for lease recovery.'
          );
          continue;
        }
        const cancellationReason =
          outcome.errorMessage ?? 'Queue job was cancelled.';
        if (!await persistClaimedJobCancellation({
          job,
          fence: claimFence,
          autonomyService,
          jobStartedAtMs,
          cancellationReason,
          cancellationRequestedAt: latestJobBeforeTerminal.cancel_requested_at,
          output: outcome.output,
          queuedGptCancellationPrivacy:
            queuedGptExecutionPrivacyState.cancellationPrivacy,
        })) {
          await autonomyService.markJobLeaseLost(
            job.id,
            'Cancellation fence was lost before the job could be finalized.'
          );
          continue;
        }
      } else {
        const failureResult = await autonomyService.handleJobFailure(
          job,
          outcome.errorMessage ?? 'Job execution failed.',
          outcome.retryable ?? false,
          outcome.output
        );
        if (failureResult.action === 'lease_lost') {
          await finalizeCancellationAfterTerminalCasMiss({
            job,
            fence: claimFence,
            autonomyService,
            jobStartedAtMs,
            queuedGptCancellationPrivacy:
              queuedGptExecutionPrivacyState.cancellationPrivacy,
          });
          continue;
        }
        if (job.job_type === 'gpt') {
          logger.warn(outcome.retryable ? 'gpt.job.retryable_failure' : 'gpt.job.non_retryable_failure', {
            jobId: job.id,
            errorMessage: outcome.errorMessage ?? 'Job execution failed.',
            retryable: outcome.retryable ?? false
          });
          recordGptJobEvent({
            event: outcome.retryable ? 'retryable_failure' : 'non_retryable_failure',
            status: 'failed',
            retryable: outcome.retryable ?? false
          });
        }
        recordWorkerJobDuration({
          jobType: job.job_type,
          outcome: failureResult.action === 'retried' ? 'retried' : 'failed',
          durationMs: Date.now() - jobStartedAtMs,
        });
        if (job.job_type === 'gpt') {
          const timings = summarizeGptJobTimings({
            created_at: job.created_at,
            started_at: new Date(jobStartedAtMs),
            completed_at: new Date()
          });
          recordGptJobTiming({
            phase: 'execution',
            outcome: failureResult.action === 'retried' ? 'retried' : 'failed',
            durationMs: timings.executionMs
          });
          recordGptJobTiming({
            phase: 'end_to_end',
            outcome: failureResult.action === 'retried' ? 'retried' : 'failed',
            durationMs: timings.endToEndMs
          });
        }
        }
      } catch (error: unknown) {
        if (jobLeaseLost) {
          logger.warn('worker.job_lease_lost.local_stop', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            jobId: job.id,
            jobType: job.job_type,
            durationMs: Date.now() - jobStartedAtMs
          });
          await autonomyService.markJobLeaseLost(
            job.id,
            'Job lease lost or job completed elsewhere.'
          );
          continue;
        }

        if (jobCancellationController.signal.aborted) {
          if (!shouldPersistClaimedJobCancellation(jobAbortState.cause)) {
            logger.info('worker.job_execution.stopped_for_recovery', {
              module: 'job-runner',
              workerId: slotDefinition.workerId,
              jobId: job.id,
              jobType: job.job_type,
              abortCause: jobAbortState.cause ?? 'unknown',
              durationMs: Date.now() - jobStartedAtMs
            });
            await autonomyService.markJobLeaseLost(
              job.id,
              'Worker stopped local execution; the live claim was left for lease recovery.'
            );
            continue;
          }
          const cancellationReason =
            jobAbortState.durableCancellationReason ??
            (jobCancellationController.signal.reason instanceof Error
              ? jobCancellationController.signal.reason.message
              : 'Queue job cancellation requested.');
          if (!await persistClaimedJobCancellation({
            job,
            fence: claimFence,
            autonomyService,
            jobStartedAtMs,
            cancellationReason,
            output: null,
            queuedGptCancellationPrivacy:
              queuedGptExecutionPrivacyState.cancellationPrivacy,
            allowPreExecutionInputFallback: !jobExecutionStarted,
          })) {
            await autonomyService.markJobLeaseLost(
              job.id,
              'Cancellation fence was lost before the aborted job could be finalized.'
            );
            continue;
          }
          continue;
        }

        const workerAiBudgetFailure = await applyWorkerAiBudgetFailureState(error);
        if (workerAiBudgetFailure) {
          const deferralResult = await autonomyService.deferJobForProviderRecovery(job, {
            delayMs: workerAiBudgetFailure.delayMs,
            errorMessage: workerAiBudgetFailure.budgetPaused
              ? 'Worker AI-call budget exhausted during provider admission; job deferred without consuming retry budget.'
              : 'Worker AI-call budget database unavailable; job deferred without consuming retry budget.',
            providerNextRetryAt: workerAiBudgetFailure.retryAt,
            providerFailureCategory: workerAiBudgetFailure.budgetPaused
              ? 'worker_ai_budget_exhausted'
              : 'worker_ai_budget_dependency_failure'
          });
          if (deferralResult.action === 'lease_lost') {
            await finalizeCancellationAfterTerminalCasMiss({
              job,
              fence: claimFence,
              autonomyService,
              jobStartedAtMs,
              queuedGptCancellationPrivacy:
                queuedGptExecutionPrivacyState.cancellationPrivacy,
              allowPreExecutionInputFallback: !jobExecutionStarted,
            });
          }
          await sleepUntilWorkerProcessSignal(runtimeSettings.pollMs);
          continue;
        }

        const classifiedError = classifyWorkerExecutionError(error);

      const providerRuntimeFailure = classifyWorkerProviderRuntimeFailure(
        error,
        classifiedError.message
      );
      if (providerRuntimeFailure) {
        const classifiedDependencyReason =
          `openai_provider_unavailable:${providerRuntimeFailure.category}`;
        if (!providerDependencyState.unavailable) {
          markWorkerProviderDependencyUnavailable(
            providerDependencyState,
            classifiedDependencyReason,
            getOpenAIProviderRuntimeStatus().nextRetryAt
          );
        }
        const dependencyReason =
          providerDependencyState.reason ?? classifiedDependencyReason;
        openai = null;
        reportOperationalState(
          'dependency_failure',
          dependencyReason,
          providerDependencyState.retryAt
        );
        await autonomyService.setClaimAcceptanceState('dependency_failure', {
          reason: dependencyReason,
          retryAt: providerDependencyState.retryAt
        });

        let recoveredClientState: WorkerProviderClientState;
        try {
          recoveredClientState = await recoverSharedWorkerProviderDependency({
            state: providerDependencyState,
            workerId: slotDefinition.workerId,
            currentConfigVersion: providerConfigVersion,
            workerBudget: workerAiCallBudget
          });
        } catch (recoveryError) {
          const workerAiBudgetFailure = await applyWorkerAiBudgetFailureState(
            recoveryError
          );
          if (!workerAiBudgetFailure) {
            throw recoveryError;
          }
          const deferralResult = await autonomyService.deferJobForProviderRecovery(job, {
            delayMs: workerAiBudgetFailure.delayMs,
            errorMessage: workerAiBudgetFailure.budgetPaused
              ? 'Worker AI-call budget exhausted during provider recovery; job deferred without consuming retry budget.'
              : 'Worker AI-call budget database unavailable during provider recovery; job deferred without consuming retry budget.',
            providerNextRetryAt: workerAiBudgetFailure.retryAt,
            providerFailureCategory: workerAiBudgetFailure.budgetPaused
              ? 'worker_ai_budget_exhausted'
              : 'worker_ai_budget_dependency_failure'
          });
          if (deferralResult.action === 'lease_lost') {
            await finalizeCancellationAfterTerminalCasMiss({
              job,
              fence: claimFence,
              autonomyService,
              jobStartedAtMs,
              queuedGptCancellationPrivacy:
                queuedGptExecutionPrivacyState.cancellationPrivacy,
              allowPreExecutionInputFallback: !jobExecutionStarted,
            });
          }
          await sleepUntilWorkerProcessSignal(runtimeSettings.pollMs);
          continue;
        }
        providerConfigVersion = recoveredClientState.configVersion;
        if (recoveredClientState.providerRecovered) {
          await autonomyService.recordProviderCircuitBreakerReset({
            providerFailureCategory: recoveredClientState.providerRecoveryCategory,
            providerNextRetryAt: recoveredClientState.providerRecoveryNextRetryAt,
            source: 'job-runner'
          });
        }
        if (!providerDependencyState.unavailable && recoveredClientState.client) {
          openai = recoveredClientState.client;
        } else {
          const unresolvedReason =
            providerDependencyState.reason ?? dependencyReason;
          reportOperationalState(
            'dependency_failure',
            unresolvedReason,
            providerDependencyState.retryAt
          );
          await autonomyService.setClaimAcceptanceState('dependency_failure', {
            reason: unresolvedReason,
            retryAt: providerDependencyState.retryAt
          });
        }
      }

      const failureResult = await autonomyService.handleJobFailure(
        job,
        classifiedError.message,
        classifiedError.retryable,
        null
      );
      if (failureResult.action === 'lease_lost') {
        await finalizeCancellationAfterTerminalCasMiss({
          job,
          fence: claimFence,
          autonomyService,
          jobStartedAtMs,
          queuedGptCancellationPrivacy:
            queuedGptExecutionPrivacyState.cancellationPrivacy,
          allowPreExecutionInputFallback: !jobExecutionStarted,
        });
        continue;
      }
      if (job.job_type === 'gpt') {
        logger.warn(classifiedError.retryable ? 'gpt.job.retryable_failure' : 'gpt.job.non_retryable_failure', {
          jobId: job.id,
          errorMessage: classifiedError.message,
          retryable: classifiedError.retryable
        });
        recordGptJobEvent({
          event: classifiedError.retryable ? 'retryable_failure' : 'non_retryable_failure',
          status: 'failed',
          retryable: classifiedError.retryable
        });
      }
      recordWorkerJobDuration({
        jobType: job.job_type,
        outcome: failureResult.action === 'retried' ? 'retried' : 'failed',
        durationMs: Date.now() - jobStartedAtMs,
      });
      if (job.job_type === 'gpt') {
        const timings = summarizeGptJobTimings({
          created_at: job.created_at,
          started_at: new Date(jobStartedAtMs),
          completed_at: new Date()
        });
        recordGptJobTiming({
          phase: 'execution',
          outcome: failureResult.action === 'retried' ? 'retried' : 'failed',
          durationMs: timings.executionMs
        });
        recordGptJobTiming({
          phase: 'end_to_end',
          outcome: failureResult.action === 'retried' ? 'retried' : 'failed',
          durationMs: timings.endToEndMs
        });
      }
      } finally {
        workerProcessShutdownController.signal.removeEventListener(
          'abort',
          abortJobOnProcessShutdown
        );
        heartbeatHandle?.stop();
      }

      await sleepUntilWorkerProcessSignal(runtimeSettings.pollMs);
      } catch (error: unknown) {
        if (isRetryableJobRunnerDatabaseBootstrapError(error)) {
          const backoffMs = Math.max(runtimeSettings.idleBackoffMs, 5_000);
          const retryLogEvent = selectJobRunnerSlotTransientRetryEvent(error);
          const dependencyReason = 'worker_budget_or_queue_database_unavailable';
          reportOperationalState('dependency_failure', dependencyReason);
          try {
            await autonomyService.setClaimAcceptanceState('dependency_failure', {
              reason: dependencyReason
            });
          } catch (snapshotError: unknown) {
            logger.warn(
              'worker.claim_dependency_state.persist_failed',
              {
                module: 'job-runner',
                workerId: slotDefinition.workerId
              },
              { errorMessage: resolveErrorMessage(snapshotError) }
            );
          }
          logger.warn(
            retryLogEvent,
            {
              module: 'job-runner',
              workerId: slotDefinition.workerId,
              backoffMs
            },
            { errorMessage: resolveErrorMessage(error) },
            error instanceof Error ? error : undefined
          );
          await sleepUntilWorkerProcessSignal(backoffMs);
          continue;
        }

        throw error;
      }
    }
  } finally {
    workerHeartbeatHandle.stop();
    await autonomyService.flushSnapshotPipeline('worker-slot-shutdown');
  }
}

async function run(): Promise<void> {
  const workerRuntimeMode = getStableWorkerRuntimeMode();
  const entrypointRuntimeMode = resolveJobRunnerEntrypointRuntimeMode(workerRuntimeMode);
  const runtimeSettings = resolveJobRunnerRuntimeSettings();
  const databaseBootstrapSettings = resolveJobRunnerDatabaseBootstrapSettings();
  logger.info('[worker-runtime] boot config', {
    module: 'job-runner',
    enabled: entrypointRuntimeMode.enabled,
    disabledReason: entrypointRuntimeMode.disabledReason,
    pollMs: runtimeSettings.pollMs,
    idleBackoffMs: runtimeSettings.idleBackoffMs,
    concurrency: runtimeSettings.concurrency,
    workerId: runtimeSettings.baseWorkerId,
    statsWorkerId: runtimeSettings.statsWorkerId,
    databaseBootstrapRetryMs: databaseBootstrapSettings.retryMs,
    databaseBootstrapMaxRetryMs: databaseBootstrapSettings.maxRetryMs,
    databaseBootstrapMaxAttempts: databaseBootstrapSettings.maxAttempts
  });
  logger.info('[worker-runtime] enabled/disabled reason', {
    module: 'job-runner',
    enabled: entrypointRuntimeMode.enabled,
    disabledReason: entrypointRuntimeMode.disabledReason,
    reason: entrypointRuntimeMode.reason,
    processKind: workerRuntimeMode.processKind,
    requestedRunWorkers: workerRuntimeMode.requestedRunWorkers
  });
  if (!entrypointRuntimeMode.enabled) {
    logger.info('[worker-runtime] start skipped', {
      module: 'job-runner',
      disabledReason: entrypointRuntimeMode.disabledReason,
      processKind: workerRuntimeMode.processKind,
      requestedRunWorkers: workerRuntimeMode.requestedRunWorkers
    });
    return;
  }

  configureDefaultArcanosCoreRuntimeProviders();
  logger.info('[worker-runtime] start requested', {
    module: 'job-runner',
    workerId: runtimeSettings.baseWorkerId,
    concurrency: runtimeSettings.concurrency
  });
  await initializeJobRunnerDatabaseWithRetry('job-runner', databaseBootstrapSettings);

  if (isWorkerProcessShutdownRequested()) {
    logger.info('worker.shutdown.before_autonomy_bootstrap', {
      module: 'job-runner',
      signal: workerProcessShutdownSignal ?? 'unknown'
    });
    return;
  }

  initializeWorkerOpenAIAdapterIfConfigured();

  const slotDefinitions = buildJobRunnerSlotDefinitions(runtimeSettings);
  const inspectorSlot = slotDefinitions[0];
  const inspectorAutonomyService = buildAutonomyServiceForSlot(inspectorSlot);
  const providerDependencyState = createWorkerProviderDependencyState();
  const operationalStateReporters = new Map(
    slotDefinitions.map(slotDefinition => [
      slotDefinition.workerId,
      createWorkerOperationalStateReporter(slotDefinition.workerId)
    ] as const)
  );
  const reportAllWorkerOperationalStates: ReturnType<
    typeof createWorkerOperationalStateReporter
  > = (state, reason, retryAt) => {
    for (const reportOperationalState of operationalStateReporters.values()) {
      reportOperationalState(state, reason, retryAt);
    }
  };
  const workerAiCallBudget = attachWorkerOperationalFailureReporting(
    inspectorAutonomyService.getWorkerAiCallBudget(),
    providerDependencyState,
    reportAllWorkerOperationalStates,
    async (reason, retryAt) => inspectorAutonomyService.setClaimAcceptanceState(
      'paused_budget',
      { reason, retryAt }
    )
  );

  const preliminaryBackstageNotionPartitionPolicy =
    resolveBackstageNotionPartitionShadowPolicy();
  const backstageNotionPartitionCutoverEvidence =
    preliminaryBackstageNotionPartitionPolicy.configuration
      ? await loadBackstageNotionPartitionCutoverGateEvidenceSet(
          preliminaryBackstageNotionPartitionPolicy.configuration
        )
      : Object.freeze([]);
  const backstageNotionPartitionPolicy =
    resolveBackstageNotionPartitionShadowPolicy(
      undefined,
      backstageNotionPartitionCutoverEvidence
    );
  try {
    const backstageNotionReadiness = await waitForWorkerStartupReadiness({
      attempt: () => runBackstageNotionWorkerReadinessGate(
        backstageNotionPartitionPolicy,
        () => ensureBackstageNotionWorkerReadiness({
          signal: workerProcessShutdownController.signal,
          workerBudget: workerAiCallBudget,
        })
      ),
      resolveRetry: async (error) => {
        if (isWorkerProcessShutdownRequested()) {
          return null;
        }
        const workerBudgetFailure = classifyWorkerAiBudgetError(
          normalizeWorkerAiBudgetError(error)
        );
        if (workerBudgetFailure) {
          const budgetPaused = workerBudgetFailure.kind === 'budget_paused';
          return {
            state: budgetPaused ? 'paused_budget' : 'dependency_failure',
            reason: budgetPaused
              ? 'ai_calls_per_hour_exceeded_during_startup_readiness'
              : 'worker_ai_budget_database_unavailable',
            retryAt: workerBudgetFailure.retryAt,
            delayMs: budgetPaused
              ? resolveProviderPauseMs(workerBudgetFailure.retryAt, 60_000)
              : Math.max(runtimeSettings.idleBackoffMs, 5_000),
          };
        }
        if (!providerDependencyState.unavailable) {
          return null;
        }

        const initialReason =
          providerDependencyState.reason ?? 'openai_provider_unavailable:unknown';
        const initialRetryAt = providerDependencyState.retryAt;
        let recoveredClientState: WorkerProviderClientState;
        try {
          recoveredClientState = await recoverSharedWorkerProviderDependency({
            state: providerDependencyState,
            workerId: inspectorSlot.workerId,
            currentConfigVersion: null,
            workerBudget: workerAiCallBudget
          });
        } catch (recoveryError) {
          const recoveryBudgetFailure = classifyWorkerAiBudgetError(
            normalizeWorkerAiBudgetError(recoveryError)
          );
          if (!recoveryBudgetFailure) {
            throw recoveryError;
          }
          const budgetPaused = recoveryBudgetFailure.kind === 'budget_paused';
          return {
            state: budgetPaused ? 'paused_budget' : 'dependency_failure',
            reason: budgetPaused
              ? 'ai_calls_per_hour_exceeded_during_startup_provider_recovery'
              : 'worker_ai_budget_database_unavailable',
            retryAt: recoveryBudgetFailure.retryAt,
            delayMs: budgetPaused
              ? resolveProviderPauseMs(recoveryBudgetFailure.retryAt, 60_000)
              : Math.max(runtimeSettings.idleBackoffMs, 5_000),
          };
        }
        if (recoveredClientState.providerRecovered) {
          await inspectorAutonomyService.recordProviderCircuitBreakerReset({
            providerFailureCategory: recoveredClientState.providerRecoveryCategory,
            providerNextRetryAt: recoveredClientState.providerRecoveryNextRetryAt,
            source: 'job-runner-startup-readiness'
          });
        }
        const retryAt = providerDependencyState.retryAt ?? initialRetryAt;
        return {
          state: 'dependency_failure',
          reason: providerDependencyState.reason ?? initialReason,
          retryAt,
          delayMs: providerDependencyState.unavailable
            ? resolveProviderPauseMs(retryAt, runtimeSettings.idleBackoffMs)
            : 0,
        };
      },
      reportPause: decision => {
        reportAllWorkerOperationalStates(
          decision.state,
          decision.reason,
          decision.retryAt
        );
      },
      wait: sleepUntilWorkerProcessSignal,
    });
    const safePolicyMetadata = {
      modeStatus: backstageNotionPartitionPolicy.modeStatus,
      requestedMode: backstageNotionPartitionPolicy.requestedMode,
      configurationStatus: backstageNotionPartitionPolicy.configurationStatus,
      reasonCode: backstageNotionPartitionPolicy.reasonCode,
      configuredUniverses: backstageNotionPartitionPolicy.configuredUniverses,
      configuredShards: backstageNotionPartitionPolicy.configuredShards,
      effectiveReadMode: backstageNotionPartitionPolicy.effectiveReadMode,
      cutoverAvailable: backstageNotionPartitionPolicy.cutoverAvailable,
      cutoverGateReasonCodes:
        backstageNotionPartitionPolicy.cutoverGateReasonCodes,
    };
    if (backstageNotionReadiness.monolithReadinessRequired) {
      logger.info('worker.backstage_notion_readiness.completed', {
        module: 'job-runner',
        monolithReadinessRequired: true,
        ...safePolicyMetadata,
        ...backstageNotionReadiness.evidence,
      });
    } else {
      logger.info('worker.backstage_notion_readiness.partition_mode_admitted', {
        module: 'job-runner',
        monolithReadinessRequired: false,
        ...safePolicyMetadata,
      });
    }
  } catch (error) {
    if (isWorkerProcessShutdownRequested()) {
      logger.info('worker.shutdown.during_backstage_notion_readiness', {
        module: 'job-runner',
        signal: workerProcessShutdownSignal ?? 'unknown'
      });
      return;
    }
    throw error;
  }

  const bootstrapResult = await bootstrapWorkerAutonomyWithRetry(
    inspectorAutonomyService,
    [`Worker bootstrap completed with ${slotDefinitions.length} consumer slot(s).`],
    databaseBootstrapSettings
  );
  const moduleRegistryStartedAtMs = Date.now();
  const moduleRegistry = await initializeModuleRegistry();

  if (isWorkerProcessShutdownRequested()) {
    logger.info('worker.shutdown.after_module_registry_preload', {
      module: 'job-runner',
      workerId: inspectorAutonomyService.getWorkerId(),
      signal: workerProcessShutdownSignal ?? 'unknown'
    });
    await inspectorAutonomyService.flushSnapshotPipeline('worker-process-shutdown');
    return;
  }

  logger.info('worker.module_registry.preloaded', {
    module: 'job-runner',
    workerId: inspectorAutonomyService.getWorkerId(),
    moduleCount: moduleRegistry.listRegisteredModules().length,
    durationMs: Date.now() - moduleRegistryStartedAtMs
  });
  if (isWorkerProcessShutdownRequested()) {
    logger.info('worker.shutdown.before_slot_start', {
      module: 'job-runner',
      workerId: inspectorAutonomyService.getWorkerId(),
      signal: workerProcessShutdownSignal ?? 'unknown'
    });
    await inspectorAutonomyService.flushSnapshotPipeline('worker-process-shutdown');
    return;
  }

  const watchdogHandle = startWatchdogLoop(inspectorAutonomyService);
  const inspectorHandle = startInspectorLoop(inspectorAutonomyService);
  const backstageNotionSynchronizationCoordinator =
    createBackstageNotionSynchronizationCoordinator();
  const partitionSyncExecutor = createBackstageNotionPartitionSyncJobExecutor({
    coordinator: backstageNotionSynchronizationCoordinator,
  });
  let backstageNotionSyncHandle: BackstageNotionSyncLoopHandle | null = null;
  let backstageNotionPartitionShadowHandle:
    BackstageNotionPartitionShadowLoopHandle | null = null;

  try {
    const slotReadinessPromises: Promise<void>[] = [];
    //audit Assumption: one Railway worker container should be able to host multiple queue-consumer slots safely; failure risk: an early readiness marker activates a revision after one slot fails while a sibling still starts; expected invariant: every slot completes synchronous dispatcher setup and remains running until the all-slot readiness barrier wins; handling strategy: race all-ready against the first runtime settlement, then keep failing the process if any long-lived slot exits unexpectedly.
    const slotRuntimePromises = slotDefinitions.map(slotDefinition => {
      let resolveSlotReadiness!: () => void;
      const slotReadinessPromise = new Promise<void>((resolve) => {
        resolveSlotReadiness = resolve;
      });
      slotReadinessPromises.push(slotReadinessPromise);

      const slotRuntimePromise = runWorkerConsumerSlot(
        slotDefinition,
        runtimeSettings,
        slotDefinition.isInspectorSlot
          ? inspectorAutonomyService
          : buildAutonomyServiceForSlot(slotDefinition),
        resolveSlotReadiness,
        partitionSyncExecutor,
        providerDependencyState,
        operationalStateReporters.get(slotDefinition.workerId)
      );
      return slotRuntimePromise;
    });

    const finishShutdownDuringSlotStart = async (): Promise<void> => {
      logger.info('worker.shutdown.during_slot_start', {
        module: 'job-runner',
        workerId: inspectorAutonomyService.getWorkerId(),
        signal: workerProcessShutdownSignal ?? 'unknown'
      });
      await Promise.all(slotRuntimePromises);
    };

    try {
      await commitAllWorkerSlotsReadyOrThrow(
        slotReadinessPromises,
        slotRuntimePromises,
        () => {
          if (isWorkerProcessShutdownRequested()) {
            throw new Error('WORKER_SHUTDOWN_BEFORE_READINESS_COMMIT');
          }

          logger.info('worker.bootstrap.completed', {
            module: 'job-runner',
            workerId: inspectorAutonomyService.getWorkerId(),
            healthStatus: bootstrapResult.healthStatus,
            slots: slotDefinitions.length,
            recovered: bootstrapResult.recovered.recoveredJobs.length,
            failed: bootstrapResult.recovered.failedJobs.length,
            cancelled: bootstrapResult.recovered.cancelledJobs?.length ?? 0
          });
          emitWorkerBootstrapReadySignal();
        }
      );
    } catch (error: unknown) {
      if (!isWorkerProcessShutdownRequested()) {
        throw error;
      }

      await finishShutdownDuringSlotStart();
      return;
    }

    if (isWorkerProcessShutdownRequested()) {
      await finishShutdownDuringSlotStart();
      return;
    }

    backstageNotionSyncHandle = startBackstageNotionSyncLoop({
      signal: workerProcessShutdownController.signal,
      coordinator: backstageNotionSynchronizationCoordinator,
      workerBudget: workerAiCallBudget,
    });
    backstageNotionPartitionShadowHandle = startBackstageNotionPartitionShadowLoop({
      signal: workerProcessShutdownController.signal,
      coordinator: backstageNotionSynchronizationCoordinator,
      workerBudget: workerAiCallBudget,
      cutoverEvidence: backstageNotionPartitionCutoverEvidence,
      loadCutoverEvidence:
        loadBackstageNotionPartitionCutoverGateEvidenceSet,
    });

    await Promise.all(slotRuntimePromises);
  } finally {
    await Promise.all([
      backstageNotionSyncHandle?.stopAndDrain(),
      backstageNotionPartitionShadowHandle?.stopAndDrain(),
    ]);
    clearInterval(watchdogHandle);
    clearInterval(inspectorHandle);
    await inspectorAutonomyService.flushSnapshotPipeline('worker-process-shutdown');
  }
}

if (isEntrypointModule(import.meta.url)) {
  run().catch(error => {
    logger.error(
      'worker.fatal',
      { module: 'job-runner' },
      { errorMessage: resolveErrorMessage(error) },
      error instanceof Error ? error : undefined
    );
    process.exit(1);
  });
}
