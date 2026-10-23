import {
  assertValidBackstageBookerActionData,
  type BackstageQueryContinuityResponse,
} from '@arcanos/protocol';
import {
  createAbortError,
  getRequestAbortContext,
  getRequestRemainingMs,
  isAbortError,
} from '@arcanos/runtime';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import {
  BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
  buildBackstageBookerTrinityRunOptions,
} from '@shared/backstage/backstageActionPolicy.js';
import {
  BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_DEFAULT_MS,
  hasBackstageRecoveryBudget,
  resolveBackstageExecutionBudgetPolicy,
} from '@shared/backstage/backstageExecutionBudget.js';
import {
  buildBackstageOutputBudgetCompletionInstruction,
  buildBackstageOutputBudgetTelemetry,
  resolveBackstageOutputBudget,
} from '@shared/backstage/backstageOutputBudget.js';
import {
  buildBackstageContinuityPolicyPrompt,
  buildBackstageContinuityResponse,
  isBackstageContinuityCursorRequestValid,
} from '@shared/backstage/backstageContinuityQueryCore.js';
import {
  BackstageContinuityQueryFailedError,
  BackstageBookerOutputIncompleteError,
  isBackstageBookerOutputIncompleteError,
  isBackstageProviderOutputLengthExhaustionError,
} from '@shared/backstage/backstageGenerationError.js';
import {
  createRuntimeBudgetWithLimit,
  getSafeRemainingMs,
} from '@platform/resilience/runtimeBudget.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import { getTrinityFinalModel } from '@services/openai/credentialProvider.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import {
  BACKSTAGE_NOTION_RAG_SYSTEM_POLICY_PROMPT,
  BackstageNotionCursorInvalidError,
} from './backstageNotionRag.js';
import {
  retrieveBackstageNotionAuthorityRagContext,
} from './backstageNotionPartitionCutover.js';
import { normalizeBackstageBookerActionPayload } from './backstageBookerContracts.js';

type ContinuityExecutionPhase =
  | 'provider_configuration'
  | 'output_budget'
  | 'request_budget'
  | 'prompt_construction'
  | 'provider_execution'
  | 'output_validation';

/** Classify local phases and known codes without exposing provider error text. */
function classifyContinuityFailure(
  error: unknown,
  phase: ContinuityExecutionPhase
): string {
  const candidate = error !== null && typeof error === 'object'
    ? error as { code?: unknown; name?: unknown }
    : {};
  if (
    phase === 'request_budget'
    || candidate.name === 'RuntimeBudgetExceededError'
    || candidate.name === 'OpenAIAbortError'
    || candidate.name === 'APIConnectionTimeoutError'
    || candidate.name === 'TimeoutError'
    || candidate.code === 'ETIMEDOUT'
    || candidate.code === 'worker_ai_call_budget_exceeded'
  ) {
    return 'budget_or_deadline_exhausted';
  }
  if (isAbortError(error)) {
    return getRequestRemainingMs() === 0
      ? 'budget_or_deadline_exhausted'
      : 'request_aborted';
  }
  if (
    phase === 'output_validation'
    || isBackstageBookerOutputIncompleteError(error)
    || candidate.code === 'OPENAI_COMPLETION_INCOMPLETE'
    || candidate.code === 'TRINITY_OUTPUT_INTEGRITY_FAILED'
  ) {
    return 'output_validation_failed';
  }
  if (
    phase === 'provider_configuration'
    || candidate.code === 'FINAL_AUTHORITY_UNAVAILABLE'
    || candidate.code === 'worker_ai_call_budget_dependency_unavailable'
  ) {
    return 'provider_unavailable_or_not_configured';
  }
  return phase === 'provider_execution'
    ? 'provider_execution_failed'
    : 'unexpected_internal_failure';
}

function safeContinuityCorrelationId(value: string | undefined): string | undefined {
  return value && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)
    ? value
    : undefined;
}

function resolveContinuityQueryModel(): string {
  return getTrinityFinalModel();
}

function resolveContinuityAttemptTimeoutMs(input: {
  executionBudget: ReturnType<typeof resolveBackstageExecutionBudgetPolicy>;
  runtimeBudget: Parameters<typeof getSafeRemainingMs>[0];
  compactRetry: boolean;
}): number {
  const recoveryReserveMs = input.compactRetry
    ? 0
    : input.executionBudget.recoveryStageTimeoutMs;
  const runtimeAvailableMs = getSafeRemainingMs(input.runtimeBudget)
    - recoveryReserveMs;
  const requestRemainingMs = getRequestRemainingMs();
  const requestAvailableMs = requestRemainingMs === null
    ? Number.POSITIVE_INFINITY
    : requestRemainingMs
      - input.executionBudget.finalizationReserveMs
      - recoveryReserveMs;
  const configuredStageTimeoutMs = input.compactRetry
    ? input.executionBudget.recoveryStageTimeoutMs
    : input.executionBudget.modelStageTimeoutMs;
  const effectiveStageTimeoutMs = Math.trunc(Math.min(
    configuredStageTimeoutMs,
    runtimeAvailableMs,
    requestAvailableMs
  ));
  if (!Number.isFinite(effectiveStageTimeoutMs) || effectiveStageTimeoutMs < 1_000) {
    throw createAbortError(
      'Backstage continuity has insufficient remaining request budget before provider dispatch.'
    );
  }
  return effectiveStageTimeoutMs;
}

/**
 * Answer one bounded, read-only continuity question from an immutable Notion
 * authority snapshot. Raw excerpts remain server-side; callers receive only a
 * synthesized answer, opaque source hashes, and explicit coverage metadata.
 */
export async function queryBackstageContinuity(
  payload: unknown
): Promise<BackstageQueryContinuityResponse> {
  if (!isBackstageContinuityCursorRequestValid(payload)) {
    throw new BackstageNotionCursorInvalidError();
  }
  const input = normalizeBackstageBookerActionPayload('queryContinuity', payload);
  const executionBudget = resolveBackstageExecutionBudgetPolicy({
    profile: 'continuity_sync',
    configuration: {
      continuityStageTimeoutMs: getEnvNumber(
        'BOOKER_CONTINUITY_STAGE_TIMEOUT_MS',
        BACKSTAGE_CONTINUITY_MODEL_STAGE_TIMEOUT_DEFAULT_MS
      ),
    },
  });
  // Start the operation budget before retrieval so slow Notion reads cannot
  // silently hand a fresh full provider window to the model stage.
  const runtimeBudget = createRuntimeBudgetWithLimit(
    executionBudget.operationTimeoutMs,
    0
  );
  const retrieval = await retrieveBackstageNotionAuthorityRagContext(
    input.universeId,
    {
      query: input.query,
      ...(input.retrievalScope ? { retrievalScope: input.retrievalScope } : {}),
      ...(input.retrievalMode ? { retrievalMode: input.retrievalMode } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    },
  );
  let phase: ContinuityExecutionPhase = 'provider_configuration';
  let attempt: 'primary' | 'compact_recovery' = 'primary';
  try {
    const { client } = getOpenAIClientOrAdapter();
    if (!client) {
      throw new Error('OpenAI client unavailable for Backstage continuity query.');
    }

    const model = resolveContinuityQueryModel();
    logger.info('backstage.continuity_query.timeout_plan', {
      profile: executionBudget.profile,
      totalTimeoutMs: executionBudget.totalTimeoutMs,
      operationTimeoutMs: executionBudget.operationTimeoutMs,
      modelStageTimeoutMs: executionBudget.modelStageTimeoutMs,
      recoveryStageTimeoutMs: executionBudget.recoveryStageTimeoutMs,
      finalizationReserveMs: executionBudget.finalizationReserveMs,
    });
    phase = 'output_budget';
    const outputBudget = resolveBackstageOutputBudget({
      action: 'queryContinuity',
      profile: executionBudget.profile,
      requestedFormat: 'continuity',
      requestedTokenLimit: BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
      promptCodeUnits: input.query.length,
      retrievedContextCodeUnits: retrieval.prompt.length,
      expectedOutputWords: 0,
      model,
      finalAuthorityModel: getTrinityFinalModel(),
      modelStageTimeoutMs: executionBudget.modelStageTimeoutMs,
    });
    logger.info(
      'backstage.continuity_query.output_budget',
      buildBackstageOutputBudgetTelemetry(outputBudget)
    );
    const runAttempt = (compactRetry: boolean) => {
      attempt = compactRetry ? 'compact_recovery' : 'primary';
      phase = 'request_budget';
      const effectiveStageTimeoutMs = resolveContinuityAttemptTimeoutMs({
        executionBudget,
        runtimeBudget,
        compactRetry,
      });
      logger.info('backstage.continuity_query.attempt_timeout', {
        profile: executionBudget.profile,
        compactRetry,
        modelStageTimeoutMs: effectiveStageTimeoutMs,
      });
      phase = 'prompt_construction';
      const policyPrompt = buildBackstageContinuityPolicyPrompt(
        input,
        retrieval,
        compactRetry
      );
      phase = 'provider_execution';
      return runTrinityWritingPipeline({
        input: {
          prompt: policyPrompt,
          moduleId: 'BACKSTAGE:BOOKER',
          sourceEndpoint: 'backstage-booker.queryContinuity',
          requestedAction: 'queryContinuity',
          body: {
            universeId: input.universeId,
            query: input.query,
            ...(input.retrievalScope ? { retrievalScope: input.retrievalScope } : {}),
            retrievalMode: input.retrievalMode ?? 'relevant',
            ...(input.cursor ? { cursor: input.cursor } : {}),
            model,
            tokenLimit: outputBudget.tokenLimit,
          },
          tokenLimit: outputBudget.tokenLimit,
          executionMode: 'request',
        },
        context: {
          client,
          runtimeBudget,
          runOptions: {
            ...buildBackstageBookerTrinityRunOptions({
              model,
              tokenLimit: outputBudget.tokenLimit,
              tokenCap: outputBudget.tokenCap,
              userIntentPrompt: input.query,
              watchdogTimeoutMs: executionBudget.operationTimeoutMs,
              modelStageTimeoutMs: effectiveStageTimeoutMs,
            }),
            disableOptionalSideEffects: true,
            trustedPolicyPrompt: policyPrompt,
            directAnswerSystemPolicyPrompt: [
              BACKSTAGE_NOTION_RAG_SYSTEM_POLICY_PROMPT,
              buildBackstageOutputBudgetCompletionInstruction(outputBudget),
            ].join('\n\n'),
            directAnswerUntrustedContextPrompt: retrieval.prompt,
            redactAuditContent: true,
          },
        },
      });
    };

    let result: Awaited<ReturnType<typeof runTrinityWritingPipeline>>;
    try {
      result = await runAttempt(false);
    } catch (error) {
      if (!isBackstageProviderOutputLengthExhaustionError(error)) {
        throw error;
      }
      if (!hasBackstageRecoveryBudget({
        policy: executionBudget,
        runtimeRemainingMs: getSafeRemainingMs(runtimeBudget),
        requestRemainingMs: getRequestRemainingMs(),
        recoveryOutputTokenLimit: outputBudget.tokenLimit,
        recoveryAttempted: false,
      })) {
        throw new BackstageBookerOutputIncompleteError();
      }
      try {
        result = await runAttempt(true);
      } catch (retryError) {
        if (isBackstageProviderOutputLengthExhaustionError(retryError)) {
          throw new BackstageBookerOutputIncompleteError();
        }
        throw retryError;
      }
    }

    phase = 'output_validation';
    return assertValidBackstageBookerActionData(
      'queryContinuity',
      buildBackstageContinuityResponse(input, retrieval, result.result)
    );
  } catch (error) {
    const universeId = safeContinuityCorrelationId(input.universeId);
    const requestId = safeContinuityCorrelationId(getRequestAbortContext()?.requestId);
    logger.error('backstage.continuity_query.failed', {
      ...(universeId ? { universeId } : {}),
      ...(requestId ? { requestId } : {}),
      category: classifyContinuityFailure(error, phase),
      phase,
      attempt,
    });
    if (isAbortError(error) || isBackstageBookerOutputIncompleteError(error)) {
      throw error;
    }
    throw new BackstageContinuityQueryFailedError();
  }
}
