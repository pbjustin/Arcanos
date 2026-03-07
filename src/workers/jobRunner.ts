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
import { runThroughBrain } from '@core/logic/trinity.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { getOpenAIAdapter, resetOpenAIAdapter } from '@core/adapters/openai.adapter.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  buildCompletedQueuedAskOutput,
  parseQueuedAskJobInput
} from '@shared/ask/asyncAskJob.js';
import { parseDagNodeJobInput } from '../jobs/jobSchema.js';
import { runDagNodeJob } from './taskRunners.js';
import {
  WorkerAutonomyService,
  classifyWorkerExecutionError
} from '@services/workerAutonomyService.js';

interface JobExecutionOutcome {
  status: 'completed' | 'failed';
  output: unknown;
  errorMessage?: string;
  retryable?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    endpointName
  } = parsedJobInput.value;

  const runtimeBudget = createRuntimeBudget();
  const trinityResult = await runThroughBrain(
    openai,
    prompt,
    sessionId,
    overrideAuditSafe,
    {
      cognitiveDomain,
      sourceEndpoint: endpointName
    },
    runtimeBudget
  );

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
    runPrompt: async (prompt, options) => {
      const runtimeBudget = createRuntimeBudget();
      return runThroughBrain(
        openai,
        prompt,
        options.sessionId,
        options.overrideAuditSafe,
        {
          cognitiveDomain: options.cognitiveDomain,
          sourceEndpoint: options.sourceEndpoint
        },
        runtimeBudget
      );
    }
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
  jobId: string
): NodeJS.Timeout {
  const intervalHandle = setInterval(() => {
    void autonomyService.recordHeartbeat(jobId).catch((error: unknown) => {
      console.warn('[jobRunner] Heartbeat failed:', resolveErrorMessage(error));
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
      console.warn('[jobRunner] Inspector failed:', resolveErrorMessage(error));
    });
  }, intervalMs);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  return intervalHandle;
}

async function run(): Promise<void> {
  const pollMs = Number(process.env.JOB_WORKER_POLL_MS || 250);
  const idleBackoffMs = Number(process.env.JOB_WORKER_IDLE_BACKOFF_MS || 1_000);
  const autonomyService = new WorkerAutonomyService();
  const dbInitialized = await initializeDatabase('job-runner');
  const dbStatus = getDatabaseStatus();

  //audit Assumption: job polling requires an initialized DB pool and schema; failure risk: immediate fatal "Database not configured" loop despite valid env vars; expected invariant: DB reports connected before queue claims start; handling strategy: fail fast with explicit status context.
  if (!dbInitialized || !dbStatus.connected) {
    throw new Error(`Database not configured (connected=${dbStatus.connected}, error=${dbStatus.error ?? 'none'})`);
  }

  let openai = initOpenAIClient();
  const bootstrapResult = await autonomyService.bootstrap(['Worker bootstrap completed.']);
  console.log(
    `[jobRunner] bootstrap status=${bootstrapResult.healthStatus} recovered=${bootstrapResult.recovered.recoveredJobs.length} failed=${bootstrapResult.recovered.failedJobs.length}`
  );

  const inspectorHandle = startInspectorLoop(autonomyService);

  try {
    while (true) {
      const budgetDecision = await autonomyService.evaluateBudgetsBeforeClaim();
      if (!budgetDecision.allowed) {
        console.warn(`[jobRunner] claim paused: ${budgetDecision.reason}`);
        await sleep(budgetDecision.sleepMs);
        continue;
      }

      const job = await claimNextPendingJob(autonomyService.getClaimOptions());

      if (!job) {
        await autonomyService.markIdle();
        await sleep(idleBackoffMs);
        continue;
      }

      await autonomyService.markJobStarted(job);
      const heartbeatHandle = startHeartbeatLoop(autonomyService, job.id);

      try {
        let outcome: JobExecutionOutcome;

        //audit Assumption: the shared queue currently supports async ask jobs and DAG node jobs only; failure risk: unknown job types spin indefinitely after claim; expected invariant: unsupported job types fail deterministically; handling strategy: branch explicitly per supported job type and centralize failure handling.
        if (job.job_type === 'ask') {
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
        } else {
          await autonomyService.handleJobFailure(
            job,
            outcome.errorMessage ?? 'Job execution failed.',
            outcome.retryable ?? false,
            outcome.output
          );
        }
      } catch (error: unknown) {
        const classifiedError = classifyWorkerExecutionError(error);

        if (classifiedError.message.toLowerCase().includes('api key') || classifiedError.message.toLowerCase().includes('openai')) {
          try {
            resetOpenAIAdapter();
            openai = initOpenAIClient();
          } catch (reinitError: unknown) {
            console.error(
              '[jobRunner] Failed to re-initialize OpenAI client during error recovery:',
              resolveErrorMessage(reinitError)
            );
          }
        }

        await autonomyService.handleJobFailure(
          job,
          classifiedError.message,
          classifiedError.retryable,
          null
        );
      } finally {
        clearInterval(heartbeatHandle);
      }

      await sleep(pollMs);
    }
  } finally {
    clearInterval(inspectorHandle);
  }
}

run().catch(error => {
  console.error(`[jobRunner] fatal: ${resolveErrorMessage(error)}`);
  process.exit(1);
});
