import { callOpenAI, getDefaultModel } from '../services/openai.js';

export interface TutorQuery {
  intent?: string;
  domain?: string;
  module?: string;
  payload?: any;
}

// ---- Pattern Registry (Domains + Modular Instruction) ----
const patterns: Record<string, { id: string; modules: Record<string, (payload: any) => Promise<any> > }> = {
  memory: {
    id: 'pattern_1756454042132',
    modules: {
      explain: async (payload) =>
        await chatWithOpenAI(`Explain memory logic for: ${payload.topic}`),
      audit: async (payload) =>
        await chatWithOpenAI(`Audit memory entry: ${payload.entry}`),
    },
  },
  logic: {
    id: 'pattern_1756453493854',
    modules: {
      clarify: async (payload) =>
        await chatWithOpenAI(`Clarify logic flow: ${payload.flow}`),
    },
  },
  default: {
    id: 'universal_fallback',
    modules: {
      generic: async (payload) =>
        await chatWithOpenAI(
          `Process generic request as a professional tutor: ${JSON.stringify(payload)}`
        ),
    },
  },
};

// ---- Helper: OpenAI Chat Wrapper ----
async function chatWithOpenAI(prompt: string, schema: { tokenLimit?: number } = {}) {
  const model = getDefaultModel();
  const limit = schema.tokenLimit ?? 200;
  const { output } = await callOpenAI(model, prompt, limit);
  return output;
}

// ---- Core Tutor Handler ----
export async function handleTutorQuery(query: TutorQuery) {
  const audit = {
    received_at: new Date().toISOString(),
    intent_clarified: query.intent || 'Unclear',
    domain_bound: null as string | null,
    instruction_module: null as string | null,
    pattern_ref: null as string | null,
    fallback_invoked: false,
  };

  // 1. Dynamic Schema Binding
  const domain = patterns[query.domain ?? ''] ? (query.domain as string) : 'default';
  audit.domain_bound = domain;

  // 2. Modular Instruction Engine
  const moduleFn =
    patterns[domain]?.modules[query.module ?? ''] || patterns.default.modules.generic;
  audit.instruction_module = query.module || 'generic';

  // 3. Pattern Reference Linking
  audit.pattern_ref = patterns[domain]?.id || 'untracked';

  // 4. Fallback Handling
  let result;
  try {
    result = await moduleFn(query.payload || {});
  } catch {
    result = { redirected_to: 'ARCANOS:RESEARCH' };
    audit.fallback_invoked = true;
  }

  // 5. Return Tutor Output with Audit
  return {
    arcanos_tutor: result,
    audit_trace: audit,
  };
}

// Backwards-compatible dispatcher used by module wrapper
export async function dispatch(payload: TutorQuery) {
  return handleTutorQuery(payload);
}

export default {
  dispatch,
  handleTutorQuery,
};

