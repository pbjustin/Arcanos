import { z } from 'zod';

export type ProtectedConfigId =
  | 'dispatch_patterns'
  | 'prompts_config'
  | 'fallback_messages'
  | 'gpt_router_config'
  | 'assistant_registry'
  | 'daemon_tokens'
  | 'protected_json_file';

export interface ProtectedConfigManifestEntry {
  id: ProtectedConfigId;
  description: string;
  expectedHashEnv: string;
  builtInExpectedHash?: string;
  allowTrustOnFirstLoad: boolean;
  requireOperatorReleaseOnFailure: boolean;
  schema: z.ZodType<unknown>;
}

const dispatchPatternBindingSchema = z.object({
  id: z.string().min(1),
  priority: z.number(),
  methods: z.array(z.string().min(1)).min(1),
  exactPaths: z.array(z.string()).optional(),
  pathRegexes: z.array(z.string()).optional(),
  pathTemplates: z.array(z.string()).optional(),
  intentHints: z.array(z.string()).optional(),
  sensitivity: z.enum(['sensitive', 'non-sensitive']),
  conflictPolicy: z.enum(['refresh_then_reroute', 'strict_block']),
  rerouteTarget: z.string().optional(),
  expectedRoute: z.string().min(1)
});

const dispatchExemptRouteSchema = z.object({
  method: z.string().min(1),
  exactPath: z.string().optional(),
  prefixPath: z.string().optional()
});

const promptsSchema = z.object({
  backstage: z.record(z.string()),
  arcanos: z.record(z.string()),
  system: z.record(z.string()),
  research: z.record(z.string()),
  reasoning: z.record(z.string()),
  security: z.record(z.string()),
  gaming: z.record(z.string()),
  trinity: z.record(z.string())
});

const gptRouterMapSchema = z.record(
  z.object({
    route: z.string().min(1),
    module: z.string().min(1)
  })
);

const assistantRegistrySchema = z.record(
  z.object({
    id: z.string().min(1),
    name: z.string().nullable(),
    instructions: z.string().nullable(),
    tools: z.unknown().nullable(),
    model: z.string().nullable().optional(),
    normalizedName: z.string().min(1)
  })
);

const daemonTokensSchema = z.record(z.string().min(1));

export const INTEGRITY_MANIFEST: Record<ProtectedConfigId, ProtectedConfigManifestEntry> = {
  dispatch_patterns: {
    id: 'dispatch_patterns',
    description: 'Dispatch v9 route pattern bindings and exemptions',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_DISPATCH_PATTERNS',
    builtInExpectedHash: '',
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    schema: z.object({
      bindings: z.array(dispatchPatternBindingSchema),
      exemptRoutes: z.array(dispatchExemptRouteSchema)
    })
  },
  prompts_config: {
    id: 'prompts_config',
    description: 'Prompt template configuration',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_PROMPTS',
    builtInExpectedHash: '',
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    schema: promptsSchema
  },
  fallback_messages: {
    id: 'fallback_messages',
    description: 'Fallback response message configuration',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_FALLBACK_MESSAGES',
    builtInExpectedHash: '',
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    schema: z.record(z.string())
  },
  gpt_router_config: {
    id: 'gpt_router_config',
    description: 'GPT route/module mapping',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG',
    builtInExpectedHash: '',
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    schema: gptRouterMapSchema
  },
  assistant_registry: {
    id: 'assistant_registry',
    description: 'Assistant registry cache file',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY',
    builtInExpectedHash: '',
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    schema: assistantRegistrySchema
  },
  daemon_tokens: {
    id: 'daemon_tokens',
    description: 'Daemon token mapping file',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_DAEMON_TOKENS',
    builtInExpectedHash: '',
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    schema: daemonTokensSchema
  },
  protected_json_file: {
    id: 'protected_json_file',
    description: 'Generic protected JSON file',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_PROTECTED_JSON',
    builtInExpectedHash: '',
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    schema: z.unknown()
  }
};
