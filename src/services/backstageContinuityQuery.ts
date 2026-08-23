import {
  assertValidBackstageBookerActionData,
  type BackstageQueryContinuityResponse,
} from '@arcanos/protocol';
import {
  createAbortError,
  getRequestRemainingMs,
  isAbortError,
} from '@arcanos/runtime';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { APPLICATION_CONSTANTS } from '@shared/constants.js';
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
import { getGPT5Model } from '@services/openai.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import {
  BACKSTAGE_NOTION_RAG_SYSTEM_POLICY_PROMPT,
  BackstageNotionCursorInvalidError,
  retrieveBackstageNotionRagContext,
} from './backstageNotionRag.js';
import { normalizeBackstageBookerActionPayload } from './backstageBookerContracts.js';

function resolveContinuityQueryModel(): string {
  const configured = getGPT5Model().trim();
  return !configured || configured.toLowerCase() === APPLICATION_CONSTANTS.MODEL_GPT_5
    ? APPLICATION_CONSTANTS.MODEL_GPT_5_1
    : configured;
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
  const retrieval = await retrieveBackstageNotionRagContext(input.universeId, {
    query: input.query,
    ...(input.retrievalScope ? { retrievalScope: input.retrievalScope } : {}),
    ...(input.retrievalMode ? { retrievalMode: input.retrievalMode } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
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
    const runAttempt = (compactRetry: boolean) => {
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
      const policyPrompt = buildBackstageContinuityPolicyPrompt(
        input,
        retrieval,
        compactRetry
      );
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
            tokenLimit: BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
          },
          tokenLimit: BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
          executionMode: 'request',
        },
        context: {
          client,
          runtimeBudget,
          runOptions: {
            ...buildBackstageBookerTrinityRunOptions({
              model,
              tokenLimit: BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
              userIntentPrompt: input.query,
              watchdogTimeoutMs: executionBudget.operationTimeoutMs,
              modelStageTimeoutMs: effectiveStageTimeoutMs,
            }),
            disableOptionalSideEffects: true,
            trustedPolicyPrompt: policyPrompt,
            directAnswerSystemPolicyPrompt: BACKSTAGE_NOTION_RAG_SYSTEM_POLICY_PROMPT,
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
        remainingOutputTokens: BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
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

    return assertValidBackstageBookerActionData(
      'queryContinuity',
      buildBackstageContinuityResponse(input, retrieval, result.result)
    );
  } catch (error) {
    if (isAbortError(error) || isBackstageBookerOutputIncompleteError(error)) {
      throw error;
    }
    logger.error('backstage.continuity_query.failed', {
      universeId: input.universeId,
    });
    throw new BackstageContinuityQueryFailedError();
  }
}
