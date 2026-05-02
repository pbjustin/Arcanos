import { runGameplayPipeline, type GamingPipelineInput } from "@services/gamingPipeline.js";
import type { GamingSuccessEnvelope } from "@services/gamingModes.js";

type GamingPipelineParams = Omit<GamingPipelineInput, "mode">;

export async function runGuidePipeline(params: GamingPipelineParams): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "guide" });
}

export async function runBuildPipeline(params: GamingPipelineParams): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "build" });
}

export async function runMetaPipeline(params: GamingPipelineParams): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "meta" });
}
