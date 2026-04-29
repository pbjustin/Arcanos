import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import type { CostControlConfig, OpenAIClient, OpenAIRequestPayload } from './types.js';

export const DEFAULT_CONFIG: CostControlConfig = {
  cacheTtlMs: 60_000,
  batchWindowMs: 500,
  rateLimitPerMinute: 5,
  requestTimeoutMs: 8_000,
  batchEndpointPath: '/openai-endpoint',
  defaultTokenLimit: 1024
};

export function createDefaultOpenAIClient(config: CostControlConfig): OpenAIClient {
  const call = async (payload: OpenAIRequestPayload) => {
    const { client } = getOpenAIClientOrAdapter();
    if (!client) {
      throw new Error('OpenAI client unavailable for cost-control Trinity execution.');
    }

    const tokenLimit = payload.maxTokens ?? config.defaultTokenLimit;
    const sourceEndpoint =
      typeof payload.metadata?.route === 'string' && payload.metadata.route.trim().length > 0
        ? payload.metadata.route.trim()
        : 'costControl.defaultOpenAIClient';

    //audit Assumption: prompt middleware traffic is user-facing generation; risk: bypassing write-plane controls; invariant: default cost-control execution enters Trinity; handling: route through the generation facade.
    return runTrinityWritingPipeline({
      input: {
        prompt: payload.prompt,
        moduleId: 'COST_CONTROL',
        sourceEndpoint,
        requestedAction: 'query',
        body: {
          prompt: payload.prompt,
          requestedModel: payload.model,
          maxTokens: tokenLimit,
          metadata: payload.metadata
        },
        maxOutputTokens: tokenLimit,
        executionMode: 'request',
        background: {
          requestedModel: payload.model ?? null,
          costControl: true
        }
      },
      context: {
        client,
        runtimeBudget: createRuntimeBudget(),
        runOptions: {
          answerMode: 'direct',
          strictUserVisibleOutput: true
        }
      }
    });
  };
  const batch = async (payloads: OpenAIRequestPayload[]) => {
    //audit Assumption: batch size can be handled sequentially; risk: latency increases; invariant: each payload yields a result; handling: Promise.all to aggregate.
    return Promise.all(payloads.map((payload) => call(payload)));
  };
  return { call, batch };
}
