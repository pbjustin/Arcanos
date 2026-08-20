import {
  assertValidBackstageBookerActionData,
  type BackstageQueryContinuityResponse,
} from '@arcanos/protocol';
import { isAbortError } from '@arcanos/runtime';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { APPLICATION_CONSTANTS } from '@shared/constants.js';
import {
  BACKSTAGE_CONTINUITY_QUERY_TOKEN_LIMIT,
  BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS,
  buildBackstageBookerTrinityRunOptions,
  resolveBackstageGenerationStageTimeoutMs,
} from '@shared/backstage/backstageActionPolicy.js';
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
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
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
    const stageTimeoutMs = resolveBackstageGenerationStageTimeoutMs(getEnvNumber(
      'BOOKER_GENERATION_STAGE_TIMEOUT_MS',
      BACKSTAGE_GENERATION_STAGE_TIMEOUT_DEFAULT_MS
    ));
    const runtimeBudget = createRuntimeBudget();
    const runAttempt = (compactRetry: boolean) => {
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
              modelStageTimeoutMs: stageTimeoutMs,
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
