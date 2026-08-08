import { z } from 'zod';
import { assistantRegistryCandidateSchema } from '@platform/runtime/assistantRegistryCandidate.js';

export type ProtectedConfigId =
  | 'dispatch_patterns'
  | 'prompts_config'
  | 'fallback_messages'
  | 'gpt_router_config'
  | 'assistant_registry'
  | 'daemon_tokens'
  | 'protected_json_file';

export interface ProtectedConfigCandidateBounds {
  maxDepth: number;
  maxNodes: number;
  maxBytes?: number;
}

export type ProtectedConfigCandidateSource =
  | {
      kind: 'dispatch_runtime';
      bounds: ProtectedConfigCandidateBounds;
    }
  | {
      kind: 'gpt_router_catalog';
      bounds: ProtectedConfigCandidateBounds;
    }
  | {
      kind: 'runtime_json_file';
      bounds: ProtectedConfigCandidateBounds & { maxBytes: number };
      resolver:
        | 'assistant_registry'
        | 'daemon_tokens'
        | 'fallback_messages'
        | 'prompts_config';
    }
  | {
      kind: 'explicit_json_file';
      bounds: ProtectedConfigCandidateBounds & { maxBytes: number };
    };

export interface ProtectedConfigManifestEntry {
  id: ProtectedConfigId;
  description: string;
  expectedHashEnv: string;
  builtInExpectedHash?: string;
  runtimeOwned: boolean;
  allowTrustOnFirstLoad: boolean;
  requireOperatorReleaseOnFailure: boolean;
  schema: z.ZodType<unknown>;
  candidateSource: ProtectedConfigCandidateSource;
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

const daemonTokensSchema = z.record(z.string().min(1));

export const INTEGRITY_MANIFEST: Record<ProtectedConfigId, ProtectedConfigManifestEntry> = {
  dispatch_patterns: {
    id: 'dispatch_patterns',
    description: 'Dispatch v9 route pattern bindings and exemptions',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_DISPATCH_PATTERNS',
    builtInExpectedHash: '',
    runtimeOwned: true,
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    candidateSource: {
      kind: 'dispatch_runtime',
      bounds: { maxDepth: 16, maxNodes: 10_000 }
    },
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
    runtimeOwned: true,
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    candidateSource: {
      kind: 'runtime_json_file',
      resolver: 'prompts_config',
      bounds: { maxBytes: 1_048_576, maxDepth: 32, maxNodes: 50_000 }
    },
    schema: promptsSchema
  },
  fallback_messages: {
    id: 'fallback_messages',
    description: 'Fallback response message configuration',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_FALLBACK_MESSAGES',
    builtInExpectedHash: '',
    runtimeOwned: true,
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    candidateSource: {
      kind: 'runtime_json_file',
      resolver: 'fallback_messages',
      bounds: { maxBytes: 262_144, maxDepth: 16, maxNodes: 10_000 }
    },
    schema: z.record(z.string())
  },
  gpt_router_config: {
    id: 'gpt_router_config',
    description: 'Declared GPT route/module mapping',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_GPT_ROUTER_CONFIG',
    builtInExpectedHash: '',
    runtimeOwned: true,
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    candidateSource: {
      kind: 'gpt_router_catalog',
      bounds: { maxDepth: 16, maxNodes: 50_000 }
    },
    schema: gptRouterMapSchema
  },
  assistant_registry: {
    id: 'assistant_registry',
    description: 'Assistant registry cache file',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_ASSISTANT_REGISTRY',
    builtInExpectedHash: '',
    runtimeOwned: true,
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    candidateSource: {
      kind: 'runtime_json_file',
      resolver: 'assistant_registry',
      bounds: { maxBytes: 16_777_216, maxDepth: 64, maxNodes: 200_000 }
    },
    schema: assistantRegistryCandidateSchema
  },
  daemon_tokens: {
    id: 'daemon_tokens',
    description: 'Daemon token mapping file',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_DAEMON_TOKENS',
    builtInExpectedHash: '',
    runtimeOwned: true,
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    candidateSource: {
      kind: 'runtime_json_file',
      resolver: 'daemon_tokens',
      bounds: { maxBytes: 1_048_576, maxDepth: 16, maxNodes: 100_000 }
    },
    schema: daemonTokensSchema
  },
  protected_json_file: {
    id: 'protected_json_file',
    description: 'Generic protected JSON file',
    expectedHashEnv: 'SAFETY_EXPECTED_HASH_PROTECTED_JSON',
    builtInExpectedHash: '',
    runtimeOwned: false,
    allowTrustOnFirstLoad: true,
    requireOperatorReleaseOnFailure: true,
    candidateSource: {
      kind: 'explicit_json_file',
      bounds: { maxBytes: 10_485_760, maxDepth: 64, maxNodes: 200_000 }
    },
    schema: z.unknown()
  }
};
