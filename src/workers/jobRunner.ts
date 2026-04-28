/**
 * Autonomous DB-backed job worker for ARCANOS async execution.
 *
 * - Claims due jobs from `job_data`
 * - Executes Trinity or DAG nodes
 * - Maintains heartbeats and leases
 * - Applies retry/backoff, budget guards, and stale-job inspection
 * - Persists worker health snapshots for cross-instance inspection
 */

import { getJobById, updateJob } from '@core/db/repositories/jobRepository.js';
import { postgresQueueSchedulerAdapter } from '@core/scheduler/postgresAdapter.js';
import {
  initializeDatabaseWithSchema as initializeDatabase,
  getStatus as getDatabaseStatus
} from '@core/db/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { getOpenAIAdapter } from '@core/adapters/openai.adapter.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  buildCompletedQueuedAskOutput,
  parseQueuedAskJobInput
} from '@shared/ask/asyncAskJob.js';
import { parseQueuedGptJobInput } from '@shared/gpt/asyncGptJob.js';
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
  buildJobRunnerSlotDefinitions,
  computeDeterministicIntervalJitterMs,
  createNonOverlappingTaskRunner,
  isEntrypointModule,
  isRetryableJobRunnerDatabaseBootstrapError,
  resolveJobRunnerDatabaseBootstrapSettings,
  resolveJobRunnerRuntimeSettings,
  type JobRunnerDatabaseBootstrapSettings,
  type JobRunnerRuntimeSettings,
  type JobRunnerSlotDefinition
} from './jobRunnerRuntime.js';
import { createDagNodeRunPromptBridge } from './dagNodePromptBridge.js';
import { runWorkerTrinityPrompt } from './trinityWorkerPipeline.js';
import { sleep } from '@shared/sleep.js';
import {
  recordGptJobEvent,
  recordGptJobTiming,
  recordWorkerJobDuration
} from '@platform/observability/appMetrics.js';
import {
  createAiExecutionContext,
  runWithAiExecutionContext,
  summarizeAiExecutionContext
} from '@services/openai/aiExecutionContext.js';
import { createAbortError, isAbortError } from '@arcanos/runtime';
import { computeGptJobLifecycleDeadlines, summarizeGptJobTimings } from '@shared/gpt/gptJobLifecycle.js';
import {
  getOpenAIProviderRuntimeStatus,
  probeOpenAIProviderHealth,
  syncOpenAIProviderRuntime
} from '@services/openai/serviceHealth.js';
import { routeGptRequest } from '@routes/_core/gptDispatch.js';
import { logger } from '@platform/logging/structuredLogging.js';

interface JobExecutionOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  output: unknown;
  errorMessage?: string;
  retryable?: boolean;
}

type OpenAIClient = ReturnType<typeof initOpenAIClient>;

const QUEUED_GPT_PROMPT_KEYS = ['prompt', 'message', 'query', 'text', 'content', 'userInput'] as const;

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
    }
  }
}

function isProviderRuntimeError(message: string): boolean {
  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes('openai') ||
    normalizedMessage.includes('api key') ||
    normalizedMessage.includes('incorrect api key') ||
    normalizedMessage.includes('authentication') ||
    normalizedMessage.includes('provider probe') ||
    normalizedMessage.includes('circuit breaker')
  );
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

function resolveProviderPauseMs(nextRetryAt: string | null, fallbackMs: number): number {
  if (!nextRetryAt) {
    return fallbackMs;
  }

  const remainingMs = Date.parse(nextRetryAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return fallbackMs;
  }

  return Math.max(1_000, Math.min(Math.max(fallbackMs, 1_000), remainingMs));
}

async function ensureOpenAIClientForSlot(params: {
  workerId: string;
  currentClient: OpenAIClient | null;
  currentConfigVersion: string | null;
  forceReload?: boolean;
}): Promise<{
  client: OpenAIClient | null;
  configVersion: string | null;
  pausedUntil: string | null;
}> {
  const sync = syncOpenAIProviderRuntime({
    forceReload: params.forceReload ?? false,
    reason: `job_runner:${params.workerId}`
  });
  const configVersion = sync.runtime.configVersion;
  const configChanged = configVersion !== params.currentConfigVersion;

  if (params.currentClient && !configChanged && !params.forceReload) {
    return {
      client: params.currentClient,
      configVersion,
      pausedUntil: sync.runtime.nextRetryAt
    };
  }

  if (
    sync.runtime.nextRetryAt &&
    Date.parse(sync.runtime.nextRetryAt) > Date.now()
  ) {
    return {
      client: null,
      configVersion,
      pausedUntil: sync.runtime.nextRetryAt
    };
  }

  const providerProbe = await probeOpenAIProviderHealth({
    source: `job_runner:${params.workerId}`
  });
  if (!providerProbe.ok) {
    return {
      client: null,
      configVersion: providerProbe.runtime.configVersion,
      pausedUntil: providerProbe.runtime.nextRetryAt
    };
  }

  try {
    return {
      client: initOpenAIClient(),
      configVersion: providerProbe.runtime.configVersion,
      pausedUntil: providerProbe.runtime.nextRetryAt
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
      pausedUntil: getOpenAIProviderRuntimeStatus().nextRetryAt
    };
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
  rawInput: unknown
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

  const dagResult = await runDagNodeJob(parsedDagJobInput.value, {
    runPrompt: createDagNodeRunPromptBridge(openai, {
      runWorkerPrompt: runWorkerTrinityPrompt
    })
  });

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
async function executeQueuedGptRequest(params: {
  jobId: string;
  rawInput: unknown;
  cancellationSignal?: AbortSignal;
}): Promise<JobExecutionOutcome> {
  const parsedGptJobInput = parseQueuedGptJobInput(params.rawInput ?? {});

  if (!parsedGptJobInput.ok) {
    return {
      status: 'failed',
      output: null,
      errorMessage: `Invalid GPT job.input: ${parsedGptJobInput.error}`,
      retryable: false
    };
  }

  const routeStartedAtMs = Date.now();
  const { gptId, body, requestId, prompt, bypassIntentRouting } = parsedGptJobInput.value;
  const hydratedBody = hydrateQueuedGptBodyPrompt(body, prompt);
  const latestJob = await getJobById(params.jobId);
  const resolveCancellationReason = async (
    fallbackMessage: string,
    error?: unknown
  ): Promise<string> => {
    const refreshedJob = await getJobById(params.jobId);
    return (
      refreshedJob?.cancel_reason ??
      (error ? resolveErrorMessage(error) : null) ??
      fallbackMessage
    );
  };
  if (latestJob?.cancel_requested_at) {
    return {
      status: 'cancelled',
      output: null,
      errorMessage: latestJob.cancel_reason ?? 'Job cancellation requested before GPT execution started.',
      retryable: false
    };
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
    envelope = await routeGptRequest({
      gptId,
      body: hydratedBody,
      requestId,
      logger: routeLogger,
      bypassIntentRouting,
      runtimeExecutionMode: 'background',
      parentAbortSignal: params.cancellationSignal
    });
  } catch (error: unknown) {
    if (params.cancellationSignal?.aborted && isAbortError(error)) {
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

    throw error;
  }

  if (!envelope.ok) {
    if (
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
      errorCode: envelope.error.code,
      errorMessage: envelope.error.message
    });
    return {
      status: 'failed',
      output: envelope,
      errorMessage: `${envelope.error.code}: ${envelope.error.message}`,
      retryable: envelope.error.code === 'MODULE_TIMEOUT' || envelope.error.code === 'MODULE_ERROR'
    };
  }

  routeLogger.info('gpt.job.completed', {
    gptId,
    requestId,
    durationMs: Date.now() - routeStartedAtMs,
    module: envelope._route.module ?? undefined,
    route: envelope._route.route ?? null
  });

  return {
    status: 'completed',
    output: envelope
  };
}

function startHeartbeatLoop(
  autonomyService: WorkerAutonomyService,
  jobId: string,
  workerId: string,
  onHeartbeat?: (job: Awaited<ReturnType<WorkerAutonomyService['recordHeartbeat']>>) => void
): NodeJS.Timeout {
  const runHeartbeat = createNonOverlappingTaskRunner(
    async () => {
      const job = await autonomyService.recordHeartbeat(jobId, { source: 'job-heartbeat' });
      onHeartbeat?.(job);
    },
    {
      taskName: 'job-heartbeat',
      onSkip: createOverlapSkipLogger(workerId, 'job-heartbeat')
    }
  );

  const intervalHandle = setInterval(() => {
    void runHeartbeat().catch((error: unknown) => {
      logger.warn(
        'worker.job_heartbeat.failed',
        { module: 'job-runner', workerId, jobId },
        { errorMessage: resolveErrorMessage(error) },
        error instanceof Error ? error : undefined
      );
    });
  }, autonomyService.getClaimOptions().leaseMs
    ? Math.max(1_000, Math.floor((autonomyService.getClaimOptions().leaseMs ?? 30_000) / 3))
    : 10_000);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  return intervalHandle;
}

function startWorkerHeartbeatLoop(
  autonomyService: WorkerAutonomyService,
  workerId: string
): WorkerHeartbeatLoopHandle {
  const intervalMs = Math.max(1_000, autonomyService.getHeartbeatIntervalMs());
  const jitterMs = computeDeterministicIntervalJitterMs(workerId, intervalMs);
  const runHeartbeat = createNonOverlappingTaskRunner(
    () => autonomyService.recordWorkerHeartbeat({ source: 'worker-heartbeat' }),
    {
      taskName: 'worker-heartbeat',
      onSkip: createOverlapSkipLogger(workerId, 'worker-heartbeat')
    }
  );
  let stopped = false;
  let startTimeoutHandle: NodeJS.Timeout | null = null;
  let intervalHandle: NodeJS.Timeout | null = null;

  const executeHeartbeat = () => {
    void runHeartbeat().catch((error: unknown) => {
      logger.warn(
        'worker.heartbeat.failed',
        { module: 'job-runner', workerId },
        { errorMessage: resolveErrorMessage(error) },
        error instanceof Error ? error : undefined
      );
    });
  };

  startTimeoutHandle = setTimeout(() => {
    if (stopped) {
      return;
    }

    executeHeartbeat();
    intervalHandle = setInterval(executeHeartbeat, intervalMs);
    if (typeof intervalHandle.unref === 'function') {
      intervalHandle.unref();
    }
  }, jitterMs);
  if (typeof startTimeoutHandle.unref === 'function') {
    startTimeoutHandle.unref();
  }

  logger.info('worker.heartbeat.stagger_scheduled', {
    module: 'worker',
    workerId,
    intervalMs,
    jitterMs
  });

  return {
    stop() {
      stopped = true;
      if (startTimeoutHandle) {
        clearTimeout(startTimeoutHandle);
        startTimeoutHandle = null;
      }
      if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
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

/**
 * Run one queue-consumer slot inside the Railway worker process.
 * Purpose: allow one deployed worker container to claim and execute multiple queue jobs concurrently.
 * Inputs/outputs: accepts one slot definition, the shared runtime settings, and an optional prebuilt autonomy service; does not resolve during normal operation.
 * Edge case behavior: unsupported or invalid job payloads fail deterministically per slot without stopping sibling slots.
 */
async function runWorkerConsumerSlot(
  slotDefinition: JobRunnerSlotDefinition,
  runtimeSettings: JobRunnerRuntimeSettings,
  autonomyService: WorkerAutonomyService = buildAutonomyServiceForSlot(slotDefinition)
): Promise<void> {
  let openai: OpenAIClient | null = null;
  let providerConfigVersion: string | null = null;
  let lastProviderPauseLogAtMs = 0;

  const initialClientState = await ensureOpenAIClientForSlot({
    workerId: slotDefinition.workerId,
    currentClient: null,
    currentConfigVersion: null
  });
  openai = initialClientState.client;
  providerConfigVersion = initialClientState.configVersion;

  logger.info('worker.slot.started', {
    module: 'job-runner',
    workerId: slotDefinition.workerId,
    slotNumber: slotDefinition.slotNumber,
    concurrency: runtimeSettings.concurrency
  });
  const workerHeartbeatHandle = startWorkerHeartbeatLoop(autonomyService, slotDefinition.workerId);

  try {
    while (!isWorkerProcessShutdownRequested()) {
      try {
        const ensuredClientState = await ensureOpenAIClientForSlot({
          workerId: slotDefinition.workerId,
          currentClient: openai,
          currentConfigVersion: providerConfigVersion
        });
        openai = ensuredClientState.client;
        providerConfigVersion = ensuredClientState.configVersion;

      if (!openai) {
        const nowMs = Date.now();
        if (nowMs - lastProviderPauseLogAtMs >= 10_000) {
          logger.warn('worker.claim.paused_provider_unavailable', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            nextRetryAt: ensuredClientState.pausedUntil ?? null
          });
          lastProviderPauseLogAtMs = nowMs;
        }
        await autonomyService.markIdle();
        await sleepUntilWorkerProcessSignal(
          resolveProviderPauseMs(ensuredClientState.pausedUntil, runtimeSettings.idleBackoffMs)
        );
        continue;
      }

      const budgetDecision = await autonomyService.evaluateBudgetsBeforeClaim();
      if (!budgetDecision.allowed) {
        logger.warn('worker.claim.paused_budget', {
          module: 'job-runner',
          workerId: slotDefinition.workerId,
          reason: budgetDecision.reason,
          sleepMs: budgetDecision.sleepMs
        });
        await sleepUntilWorkerProcessSignal(budgetDecision.sleepMs);
        continue;
      }

      const { job } = await postgresQueueSchedulerAdapter.claimNext(
        autonomyService.getClaimOptions()
      );

      if (!job) {
        await autonomyService.markIdle();
        await sleepUntilWorkerProcessSignal(runtimeSettings.idleBackoffMs);
        continue;
      }

      await autonomyService.markJobStarted(job);
      const gptCancellationController = job.job_type === 'gpt' ? new AbortController() : null;
      const abortGptOnProcessShutdown = () => {
        if (gptCancellationController && !gptCancellationController.signal.aborted) {
          gptCancellationController.abort(
            createAbortError('Worker process shutdown requested while GPT job was running.')
          );
        }
      };
      if (gptCancellationController) {
        if (workerProcessShutdownController.signal.aborted) {
          abortGptOnProcessShutdown();
        } else {
          workerProcessShutdownController.signal.addEventListener(
            'abort',
            abortGptOnProcessShutdown,
            { once: true }
          );
        }
      }
      const heartbeatHandle = startHeartbeatLoop(
        autonomyService,
        job.id,
        slotDefinition.workerId,
        (updatedJob) => {
          if (
            gptCancellationController &&
            updatedJob?.cancel_requested_at &&
            !gptCancellationController.signal.aborted
          ) {
            gptCancellationController.abort(
              createAbortError(updatedJob.cancel_reason ?? 'GPT job cancellation requested.')
            );
          }
        }
      );
      const jobStartedAtMs = Date.now();
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

      try {
        const aiExecutionContext = createAiExecutionContext({
          sourceType: 'job',
          sourceName: job.job_type,
          requestId: job.id,
          jobId: job.id,
          budget: {
            maxCalls: 24
          }
        });
        const outcome = await runWithAiExecutionContext(aiExecutionContext, async () => {
          //audit Assumption: the shared queue currently supports async ask jobs and DAG node jobs only; failure risk: unknown job types spin indefinitely after claim; expected invariant: unsupported job types fail deterministically; handling strategy: branch explicitly per supported job type and centralize failure handling.
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
            return executeQueuedDagNode(openai, job.input ?? {});
          }
          if (job.job_type === 'gpt') {
            return executeQueuedGptRequest({
              jobId: job.id,
              rawInput: job.input ?? {},
              cancellationSignal: gptCancellationController?.signal
            });
          }
          return {
            status: 'failed',
            output: null,
            errorMessage: `Unsupported job_type: ${job.job_type}`,
            retryable: false
          } satisfies JobExecutionOutcome;
        });
        const aiUsageSummary = summarizeAiExecutionContext(aiExecutionContext);
        if (aiUsageSummary && aiUsageSummary.totals.calls > 0) {
          logger.info('worker.ai.summary', {
            module: 'job-runner',
            workerId: slotDefinition.workerId,
            jobId: job.id,
            jobType: job.job_type
          }, { aiUsage: aiUsageSummary });
        }
        

      if (outcome.status === 'completed') {
        const lifecycleDeadlines =
          job.job_type === 'gpt'
            ? computeGptJobLifecycleDeadlines('completed')
            : { idempotencyUntil: null, retentionUntil: null };
        await updateJob(
          job.id,
          'completed',
          outcome.output,
          null,
          undefined,
          lifecycleDeadlines
        );
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
        const lifecycleDeadlines =
          job.job_type === 'gpt'
            ? computeGptJobLifecycleDeadlines('cancelled')
            : { idempotencyUntil: null, retentionUntil: null };
        await updateJob(
          job.id,
          'cancelled',
          outcome.output,
          outcome.errorMessage ?? 'GPT job was cancelled.',
          undefined,
          {
            ...lifecycleDeadlines,
            cancelRequestedAt: new Date().toISOString(),
            cancelReason: outcome.errorMessage ?? 'GPT job was cancelled.'
          }
        );
        await autonomyService.markJobCancelled(job.id);
        recordWorkerJobDuration({
          jobType: job.job_type,
          outcome: 'cancelled',
          durationMs: Date.now() - jobStartedAtMs,
        });
        if (job.job_type === 'gpt') {
          const timings = summarizeGptJobTimings({
            created_at: job.created_at,
            started_at: new Date(jobStartedAtMs),
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
            jobId: job.id,
            errorMessage: outcome.errorMessage ?? 'GPT job was cancelled.',
            queueWaitMs: timings.queueWaitMs,
            executionMs: timings.executionMs,
            endToEndMs: timings.endToEndMs
          });
        }
      } else {
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
        const failureResult = await autonomyService.handleJobFailure(
          job,
          outcome.errorMessage ?? 'Job execution failed.',
          outcome.retryable ?? false,
          outcome.output
        );
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
      const classifiedError = classifyWorkerExecutionError(error);

      if (isProviderRuntimeError(classifiedError.message)) {
        const recoveredClientState = await ensureOpenAIClientForSlot({
          workerId: slotDefinition.workerId,
          currentClient: null,
          currentConfigVersion: providerConfigVersion,
          forceReload: true
        });
        openai = recoveredClientState.client;
        providerConfigVersion = recoveredClientState.configVersion;
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
      const failureResult = await autonomyService.handleJobFailure(
        job,
        classifiedError.message,
        classifiedError.retryable,
        null
      );
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
          abortGptOnProcessShutdown
        );
        clearInterval(heartbeatHandle);
      }

      await sleepUntilWorkerProcessSignal(runtimeSettings.pollMs);
      } catch (error: unknown) {
        if (isRetryableJobRunnerDatabaseBootstrapError(error)) {
          const backoffMs = Math.max(runtimeSettings.idleBackoffMs, 5_000);
          logger.warn(
            'worker.database.transient_error_retry',
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
  const runtimeSettings = resolveJobRunnerRuntimeSettings();
  const databaseBootstrapSettings = resolveJobRunnerDatabaseBootstrapSettings();
  await initializeJobRunnerDatabaseWithRetry('job-runner', databaseBootstrapSettings);

  const slotDefinitions = buildJobRunnerSlotDefinitions(runtimeSettings);
  const inspectorSlot = slotDefinitions[0];
  const inspectorAutonomyService = buildAutonomyServiceForSlot(inspectorSlot);
  const bootstrapResult = await bootstrapWorkerAutonomyWithRetry(
    inspectorAutonomyService,
    [`Worker bootstrap completed with ${slotDefinitions.length} consumer slot(s).`],
    databaseBootstrapSettings
  );
  logger.info('worker.bootstrap.completed', {
    module: 'job-runner',
    workerId: inspectorAutonomyService.getWorkerId(),
    healthStatus: bootstrapResult.healthStatus,
    slots: slotDefinitions.length,
    recovered: bootstrapResult.recovered.recoveredJobs.length,
    failed: bootstrapResult.recovered.failedJobs.length
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

  try {
    //audit Assumption: one Railway worker container should be able to host multiple queue-consumer slots safely; failure risk: slot startup regression leaves the process effectively single-threaded; expected invariant: every resolved slot starts a long-lived claim loop with a distinct worker id; handling strategy: start all slots together and fail the process if any slot exits unexpectedly.
    await Promise.all(
      slotDefinitions.map(slotDefinition =>
        runWorkerConsumerSlot(
          slotDefinition,
          runtimeSettings,
          slotDefinition.isInspectorSlot
            ? inspectorAutonomyService
            : buildAutonomyServiceForSlot(slotDefinition)
        )
      )
    );
  } finally {
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
