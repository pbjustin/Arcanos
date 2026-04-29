import type {
  TrinityGenerationContext,
  TrinityGenerationFacadeRequest,
  TrinityGenerationInput
} from './trinityGenerationFacade.js';
import {
  runTrinityGenerationFacade,
  TrinityControlLeakError,
  applyTrinityGenerationInvariant,
  buildPromptFromTrinityMessages,
  classifyTrinityGenerationInput,
  resolveTrinityGenerationPrompt
} from './trinityGenerationFacade.js';
import type { TrinityResult } from './trinity.js';

export interface TrinityWritingInput extends TrinityGenerationInput {}

export interface TrinityWritingContext extends TrinityGenerationContext {}

export interface TrinityWritingPipelineRequest extends TrinityGenerationFacadeRequest {}

export {
  TrinityControlLeakError,
  applyTrinityGenerationInvariant,
  buildPromptFromTrinityMessages,
  classifyTrinityGenerationInput,
  resolveTrinityGenerationPrompt,
  runTrinityGenerationFacade
};

/**
 * Backward-compatible alias for the canonical Trinity generation facade.
 * Inputs/outputs: normalized writing input plus execution context -> structured TrinityResult.
 * Edge cases: control-plane leakage is rejected by `runTrinityGenerationFacade` before the low-level engine executes.
 */
export async function runTrinityWritingPipeline(
  params: TrinityWritingPipelineRequest
): Promise<TrinityResult> {
  return runTrinityGenerationFacade(params);
}
