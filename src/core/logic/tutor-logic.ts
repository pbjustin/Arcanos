import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { generateMockResponse } from "@services/openai.js";
import { searchScholarly } from "@services/scholarlyFetcher.js";
import {
  DEFAULT_AUDIT_SYSTEM_PROMPT,
  DEFAULT_INTAKE_SYSTEM_PROMPT,
  DEFAULT_REASONING_SYSTEM_PROMPT,
  RESEARCH_REASONING_PROMPT,
  buildGenericTutorPrompt,
  buildResearchBriefPrompt,
  buildResearchFallbackPrompt
} from "@platform/runtime/tutorPrompts.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { getEnv, getEnvNumber } from "@platform/runtime/env.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { tryExtractExactLiteralPromptShortcut } from "@services/exactLiteralPromptShortcut.js";
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';

const DEFAULT_TOKEN_LIMIT = getEnvNumber('TUTOR_DEFAULT_TOKEN_LIMIT', 200);

export interface TutorQuery {
  intent?: string;
  domain?: string;
  module?: string;
  payload?: TutorPayload;
  prompt?: string;
  message?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
}

export interface TutorPipelineTrace {
  intake: string;
  reasoning: string;
  finalized: string;
}

export interface TutorPipelineOutput {
  tutor_response: string;
  pipeline_trace: TutorPipelineTrace;
  model: {
    intake: string;
    reasoning: string;
    audit: string;
  };
}

export interface TutorModuleResult extends TutorPipelineOutput {
  metadata?: Record<string, unknown>;
}

export interface TutorPayload {
  topic?: string;
  entry?: string;
  flow?: string;
  prompt?: string;
  tokenLimit?: number;
  [key: string]: unknown;
}

function readTutorQueryPrompt(query: TutorQuery): string | undefined {
  for (const candidate of [
    query.prompt,
    query.message,
    query.userInput,
    query.content,
    query.text,
    query.query
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function readTutorPayloadValue(
  payload: TutorPayload,
  key: keyof TutorPayload
): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildResolvedTutorPayload(query: TutorQuery): TutorPayload {
  const resolvedPayload = query.payload ? { ...query.payload } : {};
  const directPrompt = readTutorQueryPrompt(query);

  //audit Assumption: `/api/ask` callers often send top-level prompt aliases instead of nesting `payload.prompt`; failure risk: tutor routing silently drops the user's actual request and generates generic filler; expected invariant: generic tutor flows always receive the operator's original text when present; handling strategy: copy the first prompt alias into `payload.prompt` unless an explicit nested prompt already exists.
  if (directPrompt && !readTutorPayloadValue(resolvedPayload, 'prompt')) {
    resolvedPayload.prompt = directPrompt;
  }

  return resolvedPayload;
}

function buildExactLiteralTutorResult(literal: string): TutorModuleResult {
  return {
    tutor_response: literal,
    pipeline_trace: {
      intake: '[SHORTCUT] Exact literal tutor shortcut matched.',
      reasoning: '[SHORTCUT] Model reasoning bypassed.',
      finalized: literal
    },
    model: {
      intake: 'exact-literal-shortcut',
      reasoning: 'exact-literal-shortcut',
      audit: 'exact-literal-shortcut'
    },
    metadata: {
      shortcut: 'exact_literal'
    }
  };
}

async function runTutorPipeline(
  prompt: string,
  options: {
    tokenLimit?: number;
    intakePrompt?: string;
    reasoningPrompt?: string;
    auditPrompt?: string;
    temperature?: number;
  } = {}
): Promise<TutorPipelineOutput> {
  const { client } = getOpenAIClientOrAdapter();
  // Use config layer for env access (adapter boundary pattern)
  const testMode = getEnv('OPENAI_API_KEY') === 'test_key_for_mocking';

  //audit Assumption: missing adapter or test mode uses mock pipeline
  if (!client || testMode) {
    const mock = generateMockResponse(prompt, 'query');
    return {
      tutor_response: mock.result || '',
      pipeline_trace: {
        intake: '[MOCK] Intake step not executed',
        reasoning: '[MOCK] Reasoning step not executed',
        finalized: mock.result || ''
      },
      model: {
        intake: 'mock',
        reasoning: 'mock',
        audit: 'mock'
      }
    };
  }

  try {
    const tokenLimit = options.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
    const tutorPrompt = [
      options.intakePrompt || DEFAULT_INTAKE_SYSTEM_PROMPT,
      options.reasoningPrompt || DEFAULT_REASONING_SYSTEM_PROMPT,
      options.auditPrompt || DEFAULT_AUDIT_SYSTEM_PROMPT,
      '',
      prompt
    ].join('\n\n');

    const trinityResult = await runTrinityWritingPipeline({
      input: {
        prompt: tutorPrompt,
        moduleId: 'ARCANOS:TUTOR',
        sourceEndpoint: 'tutor.pipeline',
        requestedAction: 'query',
        body: {
          prompt,
          tokenLimit,
          temperature: options.temperature ?? 0.3
        },
        tokenLimit,
        executionMode: 'request'
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

    const finalized = trinityResult.result.trim();

    return {
      tutor_response: finalized,
      pipeline_trace: {
        intake: prompt,
        reasoning: finalized,
        finalized
      },
      model: {
        intake: trinityResult.activeModel,
        reasoning: trinityResult.activeModel,
        audit: trinityResult.activeModel
      }
    };
  } catch (error: unknown) {
    //audit Assumption: pipeline failure should fallback to mock
    console.error('Tutor pipeline execution error:', resolveErrorMessage(error));
    const mock = generateMockResponse(prompt, 'query');
    return {
      tutor_response: mock.result || '',
      pipeline_trace: {
        intake: '[MOCK] Intake step not executed',
        reasoning: '[MOCK] Reasoning step not executed',
        finalized: mock.result || ''
      },
      model: {
        intake: 'mock',
        reasoning: 'mock',
        audit: 'mock'
      }
    };
  }
}

const patterns: Record<string, { id: string; modules: Record<string, (payload: TutorPayload) => Promise<TutorModuleResult> > }> = {
  memory: {
    id: 'pattern_1756454042132',
    modules: {
      explain: async (payload) => {
        const topic = readTutorPayloadValue(payload, 'topic') ?? readTutorPayloadValue(payload, 'prompt') ?? '';
        const pipeline = await runTutorPipeline(`Explain memory logic for: ${topic}`);
        return { ...pipeline };
      },
      audit: async (payload) => {
        const entry = readTutorPayloadValue(payload, 'entry') ?? readTutorPayloadValue(payload, 'prompt') ?? '';
        const pipeline = await runTutorPipeline(`Audit memory entry: ${entry}`);
        return { ...pipeline };
      }
    }
  },
  research: {
    id: 'pattern_1756454042135',
    modules: {
      findSources: async (payload) => {
        const topic = readTutorPayloadValue(payload, 'topic') ?? readTutorPayloadValue(payload, 'prompt') ?? '';
        const sources = await searchScholarly(topic);

        const pipeline = await runTutorPipeline(
          sources.length
            ? buildResearchBriefPrompt(topic, sources)
            : buildResearchFallbackPrompt(topic),
          {
            tokenLimit: payload.tokenLimit ?? DEFAULT_TOKEN_LIMIT,
            reasoningPrompt: RESEARCH_REASONING_PROMPT,
            temperature: 0.25
          }
        );

        return {
          ...pipeline,
          metadata: {
            sources,
            topic
          }
        };
      }
    }
  },
  logic: {
    id: 'pattern_1756453493854',
    modules: {
      clarify: async (payload) => {
        const flow = readTutorPayloadValue(payload, 'flow') ?? readTutorPayloadValue(payload, 'prompt') ?? '';
        const pipeline = await runTutorPipeline(`Clarify logic flow: ${flow}`);
        return { ...pipeline };
      }
    }
  },
  default: {
    id: 'universal_fallback',
    modules: {
      generic: async (payload) => {
        const pipeline = await runTutorPipeline(buildGenericTutorPrompt(payload));
        return { ...pipeline };
      }
    }
  }
};

/**
 * Route tutor queries through the appropriate domain/module pipeline.
 */
export async function handleTutorQuery(query: TutorQuery) {
  const audit = {
    received_at: new Date().toISOString(),
    intent_clarified: query.intent || 'Unclear',
    domain_bound: null as string | null,
    instruction_module: null as string | null,
    pattern_ref: null as string | null,
    fallback_invoked: false
  };

  //audit Assumption: unknown domains fall back to default
  const domain = patterns[query.domain ?? ''] ? (query.domain as string) : 'default';
  audit.domain_bound = domain;

  const moduleFn =
    patterns[domain]?.modules[query.module ?? ''] || patterns.default.modules.generic;
  audit.instruction_module = query.module || 'generic';

  audit.pattern_ref = patterns[domain]?.id || 'untracked';
  const resolvedPayload = buildResolvedTutorPayload(query);
  const resolvedPrompt = readTutorPayloadValue(resolvedPayload, 'prompt');

  //audit Assumption: exact-literal tutor prompts should not rely on multi-stage model compliance; failure risk: tutor pipeline adds simulated scaffolding or extra explanation around operator-required literals; expected invariant: recognized exact-literal prompts return the literal verbatim; handling strategy: short-circuit before module execution and stamp audit metadata with the shortcut path.
  const exactLiteralShortcut =
    typeof resolvedPrompt === 'string'
      ? tryExtractExactLiteralPromptShortcut(resolvedPrompt)
      : null;
  if (exactLiteralShortcut) {
    const shortcutResult = buildExactLiteralTutorResult(exactLiteralShortcut.literal);
    audit.pattern_ref = 'exact_literal_shortcut';
    audit.instruction_module = 'exact_literal_shortcut';
    return {
      arcanos_tutor: shortcutResult.tutor_response,
      audit_trace: {
        ...audit,
        pipeline: shortcutResult.pipeline_trace,
        model: shortcutResult.model
      },
      metadata: {
        shortcut: exactLiteralShortcut.matchedPattern
      }
    };
  }

  let result: TutorModuleResult;

  try {
    //audit Assumption: payload is optional; Handling: default to empty
    result = await moduleFn(resolvedPayload);
  } catch (error: unknown) {
    //audit Assumption: module failure triggers fallback
    console.error('Tutor module error:', resolveErrorMessage(error));
    const pipeline = await runTutorPipeline('Fallback tutoring response: summarize the learning request and recommend next steps.');
    result = {
      ...pipeline,
      metadata: {
        redirected_to: 'ARCANOS:RESEARCH'
      }
    };
    audit.fallback_invoked = true;
  }

  return {
    arcanos_tutor: result.tutor_response,
    audit_trace: {
      ...audit,
      pipeline: result.pipeline_trace,
      model: result.model
    },
    metadata: result.metadata
  };
}

/**
 * Dispatch tutor queries (compatibility wrapper).
 */
export async function dispatch(payload: TutorQuery) {
  return handleTutorQuery(payload);
}

export default {
  dispatch,
  handleTutorQuery
};
