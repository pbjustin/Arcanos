import { executeAIJob } from "../ai/executeJob.js";
import { readConfiguredAiRuntimePrincipalId } from "../auth/runtimeHttpAuth.js";
import type { CreateJobInput } from "./types.js";
import type { RuntimeJobPolicy } from "./policy.js";
import {
  projectPublicJobResult,
  type PublicRuntimeJobResult
} from "./publicResult.js";
import { validateCreateJobInput } from "./validation.js";

export type RuntimeJobExecutor = (
  job: CreateJobInput
) => Promise<unknown>;

export interface ProcessQueuedAIJobOptions {
  expectedPrincipalId: string;
  policy: RuntimeJobPolicy;
  execute?: RuntimeJobExecutor;
}

export async function processQueuedAIJob(
  payload: unknown,
  options: ProcessQueuedAIJobOptions
): Promise<PublicRuntimeJobResult> {
  const {
    expectedPrincipalId,
    policy,
    execute = executeAIJob
  } = options;
  const configuredPrincipalId =
    readConfiguredAiRuntimePrincipalId(expectedPrincipalId);
  if (
    !configuredPrincipalId ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as Record<string, unknown>).principalId !==
      configuredPrincipalId
  ) {
    throw new Error("Queued AI job ownership failed validation");
  }

  const validation = validateCreateJobInput(payload, policy);
  if (!validation.ok) {
    throw new Error("Queued AI job payload failed validation");
  }

  const projection = projectPublicJobResult(
    await execute(validation.data)
  );
  if (!projection.ok) {
    throw new Error("AI provider returned an unsupported result");
  }

  return projection.result;
}
