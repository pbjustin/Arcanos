import {
  getOpenAIClient,
  getDefaultModel,
  getGPT5Model,
  generateMockResponse
} from '../services/openai.js';
import { searchScholarly } from '../services/scholarlyFetcher.js';

const DEFAULT_TOKEN_LIMIT = parseInt(process.env.TUTOR_DEFAULT_TOKEN_LIMIT ?? '200', 10);

export interface TutorQuery {
  intent?: string;
  domain?: string;
  module?: string;
  payload?: any;
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
  metadata?: Record<string, any>;
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
  const client = getOpenAIClient();
  const testMode = process.env.OPENAI_API_KEY === 'test_key_for_mocking';

  if (!client || testMode) {
    const mock = generateMockResponse(prompt, 'ask');
    return {
      tutor_response: mock.result,
      pipeline_trace: {
        intake: '[MOCK] Intake step not executed',
        reasoning: '[MOCK] Reasoning step not executed',
        finalized: mock.result
      },
      model: {
        intake: 'mock',
        reasoning: 'mock',
        audit: 'mock'
      }
    };
  }

  try {
    const intakeModel = getDefaultModel();
    const reasoningModel = getGPT5Model();
    const auditModel = getDefaultModel();
    const tokenLimit = options.tokenLimit ?? DEFAULT_TOKEN_LIMIT;

    const intakeResponse = await client.chat.completions.create({
      model: intakeModel,
      messages: [
        {
          role: 'system',
          content: options.intakePrompt || 'ARCANOS Intake: Route to Tutor module.'
        },
        { role: 'user', content: prompt }
      ],
      max_tokens: tokenLimit
    });

    const refinedPrompt = intakeResponse.choices[0]?.message?.content?.trim() || prompt;

    const reasoningResponse = await client.chat.completions.create({
      model: reasoningModel,
      messages: [
        {
          role: 'system',
          content:
            options.reasoningPrompt ||
            'You are ARCANOS:TUTOR, a professional educator. Provide structured, learner-friendly guidance that builds understanding step by step.'
        },
        { role: 'user', content: refinedPrompt }
      ],
      temperature: options.temperature ?? 0.3,
      max_tokens: tokenLimit
    });

    const reasoningOutput = reasoningResponse.choices[0]?.message?.content?.trim() || '';

    const auditResponse = await client.chat.completions.create({
      model: auditModel,
      messages: [
        {
          role: 'system',
          content:
            options.auditPrompt ||
            'ARCANOS Audit: Validate the tutoring response for accuracy, clarity, and pedagogical tone. Fix issues while preserving intent.'
        },
        { role: 'user', content: reasoningOutput }
      ],
      max_tokens: tokenLimit
    });

    const finalized = auditResponse.choices[0]?.message?.content?.trim() || reasoningOutput;

    return {
      tutor_response: finalized,
      pipeline_trace: {
        intake: refinedPrompt,
        reasoning: reasoningOutput,
        finalized
      },
      model: {
        intake: intakeModel,
        reasoning: reasoningModel,
        audit: auditModel
      }
    };
  } catch (error) {
    console.error('Tutor pipeline execution error:', error);
    const mock = generateMockResponse(prompt, 'ask');
    return {
      tutor_response: mock.result,
      pipeline_trace: {
        intake: '[MOCK] Intake step not executed',
        reasoning: '[MOCK] Reasoning step not executed',
        finalized: mock.result
      },
      model: {
        intake: 'mock',
        reasoning: 'mock',
        audit: 'mock'
      }
    };
  }
}

const patterns: Record<string, { id: string; modules: Record<string, (payload: any) => Promise<TutorModuleResult> > }> = {
  memory: {
    id: 'pattern_1756454042132',
    modules: {
      explain: async (payload) => {
        const pipeline = await runTutorPipeline(`Explain memory logic for: ${payload.topic}`);
        return { ...pipeline };
      },
      audit: async (payload) => {
        const pipeline = await runTutorPipeline(`Audit memory entry: ${payload.entry}`);
        return { ...pipeline };
      }
    }
  },
  research: {
    id: 'pattern_1756454042135',
    modules: {
      findSources: async (payload) => {
        const topic = (payload?.topic as string) || '';
        const sources = await searchScholarly(topic);
        const list = sources
          .map(
            (s, i) => `${i + 1}. ${s.title} (${s.year}) - ${s.journal}`
          )
          .join('\n');

        const pipeline = await runTutorPipeline(
          sources.length
            ? `Create a concise learning brief about ${topic} using the numbered academic sources below. Cite them inline as [source #] and highlight key takeaways for students.\n\n${list}`
            : `No scholarly sources were located. Provide a credible overview of ${topic} and recommend next steps for finding academic references.`,
          {
            tokenLimit: payload?.tokenLimit ?? DEFAULT_TOKEN_LIMIT,
            reasoningPrompt:
              'You are ARCANOS:TUTOR, an academic mentor. Synthesize the provided material into clear guidance with citations where possible.',
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
        const pipeline = await runTutorPipeline(`Clarify logic flow: ${payload.flow}`);
        return { ...pipeline };
      }
    }
  },
  default: {
    id: 'universal_fallback',
    modules: {
      generic: async (payload) => {
        const pipeline = await runTutorPipeline(
          `Process this request as a professional tutor. Respond with clear steps and checks for understanding. Input: ${JSON.stringify(payload)}`
        );
        return { ...pipeline };
      }
    }
  }
};

export async function handleTutorQuery(query: TutorQuery) {
  const audit = {
    received_at: new Date().toISOString(),
    intent_clarified: query.intent || 'Unclear',
    domain_bound: null as string | null,
    instruction_module: null as string | null,
    pattern_ref: null as string | null,
    fallback_invoked: false
  };

  const domain = patterns[query.domain ?? ''] ? (query.domain as string) : 'default';
  audit.domain_bound = domain;

  const moduleFn =
    patterns[domain]?.modules[query.module ?? ''] || patterns.default.modules.generic;
  audit.instruction_module = query.module || 'generic';

  audit.pattern_ref = patterns[domain]?.id || 'untracked';

  let result: TutorModuleResult;

  try {
    result = await moduleFn(query.payload || {});
  } catch (error) {
    console.error('Tutor module error:', error);
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

export async function dispatch(payload: TutorQuery) {
  return handleTutorQuery(payload);
}

export default {
  dispatch,
  handleTutorQuery
};
