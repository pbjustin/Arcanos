import type { ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { getConfig, getStableWorkerRuntimeMode } from '@platform/runtime/unifiedConfig.js';
import { ARCANOS_BEHAVIORAL_PROFILE } from '@shared/gpt/arcanosBehavioralProfile.js';
import { resolveGenerativeModelFromConfig } from '@shared/gpt/generativeModelPolicyCore.js';

/** Profile identity is independent of the provider's actual model identity. */
export function getBehavioralProfileTelemetry(): {
  behavioralProfileId?: string;
  behavioralProfileService?: string;
} {
  const config = getConfig();
  if (!config.generativeAuthorityMode || config.generativeAuthorityMode === 'legacy-finetune') {
    return {};
  }
  // Reuse the authority gate so malformed migration settings cannot emit a success marker.
  resolveGenerativeModelFromConfig(config, 'final');
  return {
    behavioralProfileId: ARCANOS_BEHAVIORAL_PROFILE.id,
    behavioralProfileService: getStableWorkerRuntimeMode().processKind
  };
}

/** Add only repository-owned policy; leave task input, tools and output schemas intact. */
export function prepareBehavioralProfileRequest<T extends ResponseCreateParamsNonStreaming>(payload: T): T {
  const telemetry = getBehavioralProfileTelemetry();
  if (!telemetry.behavioralProfileId || payload.model !== 'gpt-6.1-sol') {
    return payload;
  }
  const profile = ARCANOS_BEHAVIORAL_PROFILE.instructions;
  const instructions = payload.instructions ?? '';
  return {
    ...payload,
    instructions: instructions.startsWith(profile)
      ? instructions
      : [profile, instructions].filter(Boolean).join('\n\n'),
    metadata: {
      ...payload.metadata,
      arcanos_behavioral_profile: telemetry.behavioralProfileId,
      arcanos_service: telemetry.behavioralProfileService ?? 'unknown'
    }
  };
}
