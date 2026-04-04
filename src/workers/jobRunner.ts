/**
 * Autonomous DB-backed job worker for ARCANOS async execution.
 *
 * - Claims due jobs from `job_data`
 * - Executes Trinity or DAG nodes
 * - Maintains heartbeats and leases
 * - Applies retry/backoff, budget guards, and stale-job inspection
 * - Persists worker health snapshots for cross-instance inspection
 */

import { claimNextPendingJob, updateJob } from '@core/db/repositories/jobRepository.js';
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
import { parseDagNodeJobInput } from '../jobs/jobSchema.js';
import { runDagNodeJob } from './taskRunners.js';
import {
  WorkerAutonomyService,
  getWorkerAutonomySettings,
  classifyWorkerExecutionError
} from '@services/workerAutonomyService.js';
import {
  buildJobRunnerSlotDefinitions,
  resolveJobRunnerRuntimeSettings,
  type JobRunnerRuntimeSettings,
  type JobRunnerSlotDefinition
} from './jobRunnerRuntime.js';
import { createDagNodeRunPromptBridge } from './dagNodePromptBridge.js';
import { runWorkerTrinityPrompt } from './trinityWorkerPipeline.js';
import { sleep } from '@shared/sleep.js';
import { recordWorkerJobDuration } from '@platform/observability/appMetrics.js';
import {
  getOpenAIProviderRuntimeStatus,
  probeOpenAIProviderHealth,
  syncOpenAIProviderRuntime
} from '@services/openai/serviceHealth.js';

interface JobExecutionOutcome {
  status: 'completed' | 'failed';
  output: unknown;
  errorMessage?: string;
  retryable?: boolean;
}

type OpenAIClient = ReturnType<typeof initOpenAIClient>;

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
    console.error(
      `[jobRunner] worker=${params.workerId} failed to initialize OpenAI client after a healthy probe:`,
      resolveErrorMessage(error)
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
    strictUserVisibleOutput
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
    strictUserVisibleOutput
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
    const classifiedFailure = classifyWorkerExecutionError(
      dagResult.errorMessage ?? 'DAG node failed.'
    );
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

function startHeartbeatLoop(
  autonomyService: WorkerAutonomyService,
  jobId: string,
  workerId: string
): NodeJS.Timeout {
  const intervalHandle = setInterval(() => {
    void autonomyService.recordHeartbeat(jobId).catch((error: unknown) => {
      console.warn(
        `[jobRunner] worker=${workerId} heartbeat failed:`,
        resolveErrorMessage(error)
      );
    });
  }, autonomyService.getClaimOptions().leaseMs ? Math.max(1_000, Math.floor((autonomyService.getClaimOptions().leaseMs ?? 30_000) / 3)) : 10_000);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  return intervalHandle;
}

function startInspectorLoop(autonomyService: WorkerAutonomyService): NodeJS.Timeout {
  const intervalMs = Math.max(5_000, Number(process.env.JOB_WORKER_INSPECTOR_MS || 30_000));
  const intervalHandle = setInterval(() => {
    void autonomyService.inspect('scheduled').catch((error: unknown) => {
      console.warn(
        `[jobRunner] worker=${autonomyService.getWorkerId()} inspector failed:`,
        resolveErrorMessage(error)
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
): Promise<never> {
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

  console.log(
    `[jobRunner] worker=${slotDefinition.workerId} slot=${slotDefinition.slotNumber}/${runtimeSettings.concurrency} started`
  );

  while (true) {
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
        console.warn(
          `[jobRunner] worker=${slotDefinition.workerId} claim paused: openai_provider_unavailable nextRetryAt=${ensuredClientState.pausedUntil ?? 'unknown'}`
        );
        lastProviderPauseLogAtMs = nowMs;
      }
      await autonomyService.markIdle();
      await sleep(resolveProviderPauseMs(ensuredClientState.pausedUntil, runtimeSettings.idleBackoffMs));
      continue;
    }

    const budgetDecision = await autonomyService.evaluateBudgetsBeforeClaim();
    if (!budgetDecision.allowed) {
      console.warn(
        `[jobRunner] worker=${slotDefinition.workerId} claim paused: ${budgetDecision.reason}`
      );
      await sleep(budgetDecision.sleepMs);
      continue;
    }

    const job = await claimNextPendingJob(autonomyService.getClaimOptions());

    if (!job) {
      await autonomyService.markIdle();
      await sleep(runtimeSettings.idleBackoffMs);
      continue;
    }

    await autonomyService.markJobStarted(job);
    const heartbeatHandle = startHeartbeatLoop(
      autonomyService,
      job.id,
      slotDefinition.workerId
    );
    const jobStartedAtMs = Date.now();

    try {
      let outcome: JobExecutionOutcome;

      //audit Assumption: the shared queue currently supports async ask jobs and DAG node jobs only; failure risk: unknown job types spin indefinitely after claim; expected invariant: unsupported job types fail deterministically; handling strategy: branch explicitly per supported job type and centralize failure handling.
      if (!openai) {
        outcome = {
          status: 'failed',
          output: null,
          errorMessage: 'OpenAI provider unavailable; job execution deferred until provider recovery.',
          retryable: true
        };
      } else if (job.job_type === 'ask') {
        outcome = await executeQueuedPrompt(openai, job.input ?? {});
      } else if (job.job_type === 'dag-node') {
        outcome = await executeQueuedDagNode(openai, job.input ?? {});
      } else {
        outcome = {
          status: 'failed',
          output: null,
          errorMessage: `Unsupported job_type: ${job.job_type}`,
          retryable: false
        };
      }

      if (outcome.status === 'completed') {
        await updateJob(job.id, 'completed', outcome.output, null);
        await autonomyService.markJobCompleted(job.id);
        recordWorkerJobDuration({
          jobType: job.job_type,
          outcome: 'completed',
          durationMs: Date.now() - jobStartedAtMs,
        });
      } else {
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
    } finally {
      clearInterval(heartbeatHandle);
    }

    await sleep(runtimeSettings.pollMs);
  }
}

async function run(): Promise<void> {
  const runtimeSettings = resolveJobRunnerRuntimeSettings();
  const dbInitialized = await initializeDatabase('job-runner');
  const dbStatus = getDatabaseStatus();

  //audit Assumption: job polling requires an initialized DB pool and schema; failure risk: immediate fatal "Database not configured" loop despite valid env vars; expected invariant: DB reports connected before queue claims start; handling strategy: fail fast with explicit status context.
  if (!dbInitialized || !dbStatus.connected) {
    throw new Error(`Database not configured (connected=${dbStatus.connected}, error=${dbStatus.error ?? 'none'})`);
  }

  const slotDefinitions = buildJobRunnerSlotDefinitions(runtimeSettings);
  const inspectorSlot = slotDefinitions[0];
  const inspectorAutonomyService = buildAutonomyServiceForSlot(inspectorSlot);
  const bootstrapResult = await inspectorAutonomyService.bootstrap([
    `Worker bootstrap completed with ${slotDefinitions.length} consumer slot(s).`
  ]);
  console.log(
    `[jobRunner] bootstrap status=${bootstrapResult.healthStatus} slots=${slotDefinitions.length} recovered=${bootstrapResult.recovered.recoveredJobs.length} failed=${bootstrapResult.recovered.failedJobs.length}`
  );

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
    clearInterval(inspectorHandle);
  }
}

run().catch(error => {
  console.error(`[jobRunner] fatal: ${resolveErrorMessage(error)}`);
  process.exit(1);
});
