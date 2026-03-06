/**
 * Simple DB-backed job worker for ARCANOS async execution.
 *
 * - Claims pending jobs from `job_data`
 * - Executes Trinity (runThroughBrain)
 * - Writes output back to DB
 */

import { claimNextPendingJob, updateJob } from "@core/db/repositories/jobRepository.js";
import { initializeDatabaseWithSchema as initializeDatabase, getStatus as getDatabaseStatus } from "@core/db/index.js";
import { runThroughBrain } from "@core/logic/trinity.js";
import { createRuntimeBudget } from "@platform/resilience/runtimeBudget.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { getOpenAIAdapter, resetOpenAIAdapter } from "@core/adapters/openai.adapter.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import {
  buildCompletedQueuedAskOutput,
  parseQueuedAskJobInput
} from "@shared/ask/asyncAskJob.js";

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

async function run(): Promise<void> {
  const pollMs = Number(process.env.JOB_WORKER_POLL_MS || 250);
  const idleBackoffMs = Number(process.env.JOB_WORKER_IDLE_BACKOFF_MS || 1000);
  const dbInitialized = await initializeDatabase('job-runner');
  const dbStatus = getDatabaseStatus();

  //audit Assumption: job polling requires an initialized DB pool and schema; failure risk: immediate fatal "Database not configured" loop despite valid env vars; expected invariant: DB reports connected before queue claims start; handling strategy: fail fast with explicit status context.
  if (!dbInitialized || !dbStatus.connected) {
    throw new Error(`Database not configured (connected=${dbStatus.connected}, error=${dbStatus.error ?? 'none'})`);
  }

  let openai = initOpenAIClient();

  // Main loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await claimNextPendingJob();

    if (!job) {
      await sleep(idleBackoffMs);
      continue;
    }

    try {
      if (job.job_type !== 'ask') {
        await updateJob(job.id, 'failed', null, `Unsupported job_type: ${job.job_type}`);
        continue;
      }

      const parsedJobInput = parseQueuedAskJobInput(job.input ?? {});

      //audit Assumption: malformed queue payloads should fail only the affected job; failure risk: worker crash or poison-job retry loop; expected invariant: invalid `job.input` produces a deterministic failed job state; handling strategy: validate first and short-circuit with explicit error.
      if (!parsedJobInput.ok) {
        await updateJob(job.id, 'failed', null, `Invalid job.input: ${parsedJobInput.error}`);
        continue;
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

      const completedOutput = buildCompletedQueuedAskOutput(trinityResult, parsedJobInput.value);
      await updateJob(job.id, 'completed', completedOutput, null);
    } catch (err: unknown) {
      const msg = resolveErrorMessage(err);

      if (msg.toLowerCase().includes('api key') || msg.toLowerCase().includes('openai')) {
        try {
          resetOpenAIAdapter();
          openai = initOpenAIClient();
        } catch (reinitError: unknown) {
          console.error('[jobRunner] Failed to re-initialize OpenAI client during error recovery:', resolveErrorMessage(reinitError));
        }
      }

      await updateJob(job.id, 'failed', null, msg);
    }

    // tiny pause to reduce tight-loop DB pressure when job volume is high
    await sleep(pollMs);
  }
}

run().catch(err => {
  // eslint-disable-next-line no-console
  console.error(`[jobRunner] fatal: ${resolveErrorMessage(err)}`);
  process.exit(1);
});
