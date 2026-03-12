import type { ClientContextDTO } from '@shared/types/dto.js';
import type { TrinityPipelineDebug, TrinityResult } from '@core/logic/trinity.js';
import { shouldExposePipelineDebug } from '@core/logic/trinityHonesty.js';

/**
 * Optional audit metadata carried across async `/ask` queue boundaries.
 * Purpose: let response serializers preserve lenient-schema audit hints without exposing internal Trinity traces.
 * Inputs/Outputs: stable audit flag shape used by `/ask` and `/jobs/:id`.
 * Edge cases: omitted when schema bypassing did not occur.
 */
export interface TrinityResponseAuditFlag {
  auditFlag: 'SCHEMA_VALIDATION_BYPASS';
  reason: string;
  timestamp: string;
}

/**
 * Minimal user-visible Trinity response shared by sync and async HTTP routes.
 * Purpose: expose the answer and stable route metadata while suppressing internal pipeline state by default.
 * Inputs/Outputs: serialized Trinity result plus optional endpoint/client metadata.
 * Edge cases: `pipelineDebug` appears only when debug capture is enabled and strict user-visible output is disabled.
 */
export interface TrinityUserVisibleResponse {
  result: string;
  module: string;
  meta: TrinityResult['meta'];
  activeModel: string;
  fallbackFlag: boolean;
  endpoint?: string;
  routingStages?: string[];
  gpt5Used?: boolean;
  gpt5Model?: string;
  dryRun: boolean;
  error?: string;
  clientContext?: ClientContextDTO;
  auditFlag?: TrinityResponseAuditFlag;
  pipelineDebug?: TrinityPipelineDebug;
}

/**
 * Serialize a Trinity result for user-visible HTTP responses.
 *
 * Purpose:
 * - Keep default route output focused on the final answer while optionally exposing debug traces behind an explicit relaxed-output request.
 *
 * Inputs/outputs:
 * - Input: Trinity result plus route-level metadata to preserve.
 * - Output: normalized user-visible payload suitable for JSON APIs.
 *
 * Edge case behavior:
 * - Debug data is omitted unless `debugPipeline=true`, `answerMode=debug`, and `strictUserVisibleOutput=false`.
 */
export function buildTrinityUserVisibleResponse(params: {
  trinityResult: TrinityResult;
  endpoint?: string;
  clientContext?: ClientContextDTO;
  auditFlag?: TrinityResponseAuditFlag;
}): TrinityUserVisibleResponse {
  const userVisibleResponse: TrinityUserVisibleResponse = {
    result: params.trinityResult.result,
    module: params.trinityResult.module,
    meta: params.trinityResult.meta,
    activeModel: params.trinityResult.activeModel,
    fallbackFlag: params.trinityResult.fallbackFlag,
    routingStages: params.trinityResult.routingStages,
    gpt5Used: params.trinityResult.gpt5Used,
    gpt5Model: params.trinityResult.gpt5Model,
    dryRun: params.trinityResult.dryRun,
    error: params.trinityResult.gpt5Error,
    ...(params.endpoint ? { endpoint: params.endpoint } : {}),
    ...(params.clientContext ? { clientContext: params.clientContext } : {}),
    ...(params.auditFlag ? { auditFlag: params.auditFlag } : {})
  };

  //audit Assumption: captured debug traces are internal by default even when the run collected them; failure risk: ordinary clients receive intake/reasoning internals; expected invariant: debug payloads require both debug mode and relaxed strict-output gating; handling strategy: attach `pipelineDebug` only when the explicit exposure rule passes.
  if (
    params.trinityResult.outputControls &&
    params.trinityResult.pipelineDebug &&
    shouldExposePipelineDebug(params.trinityResult.outputControls)
  ) {
    userVisibleResponse.pipelineDebug = params.trinityResult.pipelineDebug;
  }

  return userVisibleResponse;
}
