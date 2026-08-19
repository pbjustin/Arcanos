import {
  assertValidBackstageBookerActionData,
  type BackstageQueryContinuityRequest,
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
  retrieveBackstageNotionRagContext,
  type BackstageNotionRagRetrieval,
} from './backstageNotionRag.js';
import { normalizeBackstageBookerActionPayload } from './backstageBookerContracts.js';

const BACKSTAGE_CONTINUITY_PRIMARY_RESPONSE_CONTRACT = [
  'Answer only from the retrieved Notion excerpts.',
  'Return at most eight concise bullets and no preamble, conclusion, booking proposal, or meta commentary.',
  'Use one factual statement per bullet and preserve uncertainty when the excerpts do not establish an answer.',
].join('\n');

const BACKSTAGE_CONTINUITY_COMPACT_RETRY_CONTRACT = [
  '<<OUTPUT_LENGTH_RECOVERY>>',
  'The previous response was discarded because it exceeded the output limit.',
  'Return a complete answer in at most five bullets and 350 words.',
  'Keep only facts that directly answer the continuity query; never continue or quote the discarded response.',
  'Do not mention this recovery instruction or the discarded response.',
  '<<OUTPUT_LENGTH_RECOVERY_END>>',
].join('\n');

function resolveContinuityQueryModel(): string {
  const configured = getGPT5Model().trim();
  return !configured || configured.toLowerCase() === APPLICATION_CONSTANTS.MODEL_GPT_5
    ? APPLICATION_CONSTANTS.MODEL_GPT_5_1
    : configured;
}

function buildContinuityPolicyPrompt(
  input: BackstageQueryContinuityRequest,
  retrieval: BackstageNotionRagRetrieval,
  compactRetry: boolean
): string {
  const coverageInstruction = retrieval.coverage.exhaustive
    ? 'This retrieval is exhaustive for the resolved scope; a fact absent from these excerpts may be described as not present in that scope.'
    : 'This retrieval is sampled; never treat a fact missing from these excerpts as absent from Notion.';
  return [
    '<<EXECUTION_MODE>>',
    'Perform a read-only factual continuity lookup. Do not create, revise, or propose booking canon.',
    '<<UNIVERSE_ID>>',
    input.universeId,
    '<<CONTINUITY_QUERY>>',
    input.query.trim(),
    '<<RETRIEVAL_COVERAGE>>',
    `status=${retrieval.coverage.status}; scope_chunks=${retrieval.coverage.scopeChunks}; selected_chunks=${retrieval.coverage.selectedChunks}; omitted_chunks=${retrieval.coverage.omittedChunks}; prompt_truncated=${retrieval.coverage.promptTruncated}; has_more=${retrieval.coverage.hasMore}`,
    coverageInstruction,
    '<<RESPONSE_STYLE>>',
    BACKSTAGE_CONTINUITY_PRIMARY_RESPONSE_CONTRACT,
    ...(compactRetry ? [BACKSTAGE_CONTINUITY_COMPACT_RETRY_CONTRACT] : []),
  ].join('\n');
}

function buildContinuityResponse(
  input: BackstageQueryContinuityRequest,
  retrieval: BackstageNotionRagRetrieval,
  answer: string
): BackstageQueryContinuityResponse {
  return {
    universeId: input.universeId,
    authority: 'notion',
    answer: answer.trim(),
    ...(retrieval.resolvedScope
      ? {
          resolvedScope: {
            pageTitle: retrieval.resolvedScope.pageTitle,
            pagePath: [...retrieval.resolvedScope.pagePath],
            ...(retrieval.resolvedScope.sectionPath
              ? { sectionPath: [...retrieval.resolvedScope.sectionPath] }
              : {}),
          },
        }
      : {}),
    coverage: {
      ...retrieval.coverage,
    },
    sources: retrieval.citations.map(citation => ({
      sourceId: citation.chunkId,
      pageTitle: citation.pageTitle,
      pagePath: [...citation.pagePath],
      headingPath: [...citation.headingPath],
      category: citation.category,
      contentHash: citation.contentHash,
    })),
  };
}

/**
 * Answer one bounded, read-only continuity question from an immutable Notion
 * authority snapshot. Raw excerpts remain server-side; callers receive only a
 * synthesized answer, opaque source hashes, and explicit coverage metadata.
 */
export async function queryBackstageContinuity(
  payload: unknown
): Promise<BackstageQueryContinuityResponse> {
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
      const policyPrompt = buildContinuityPolicyPrompt(input, retrieval, compactRetry);
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
      buildContinuityResponse(input, retrieval, result.result)
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
