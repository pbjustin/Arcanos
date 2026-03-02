/**
 * Simple DB-backed job worker for ARCANOS async execution.
 *
 * - Claims pending jobs from `job_data`
 * - Executes Trinity (runThroughBrain)
 * - Writes output back to DB
 */

import { claimNextPendingJob, updateJob } from "@core/db/repositories/jobRepository.js";
import { runThroughBrain } from "@core/logic/trinity.js";
import { createRuntimeBudget } from "@platform/resilience/runtimeBudget.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";
import { getOpenAIAdapter, resetOpenAIAdapter } from "@core/adapters/openai.adapter.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import type { CognitiveDomain } from "@shared/types/cognitiveDomain.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const COGNITIVE_DOMAIN_VALUES: readonly CognitiveDomain[] = ['diagnostic', 'code', 'creative', 'natural', 'execution'];

function normalizeCognitiveDomain(value: unknown): CognitiveDomain | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return COGNITIVE_DOMAIN_VALUES.includes(value as CognitiveDomain) ? (value as CognitiveDomain) : undefined;
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

      const input = (job.input ?? {}) as Record<string, unknown>;
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      const sessionId = typeof input.sessionId === 'string' ? input.sessionId : undefined;
      const overrideAuditSafe = typeof input.overrideAuditSafe === 'string' ? input.overrideAuditSafe : undefined;
      const cognitiveDomain = normalizeCognitiveDomain(input.cognitiveDomain);

      if (!prompt) {
        await updateJob(job.id, 'failed', null, 'Missing prompt in job.input');
        continue;
      }

      const runtimeBudget = createRuntimeBudget();
      const output = await runThroughBrain(
        openai,
        prompt,
        sessionId,
        overrideAuditSafe,
        { cognitiveDomain },
        runtimeBudget
      );

      await updateJob(job.id, 'completed', output, null);
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
