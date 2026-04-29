import type OpenAI from 'openai';
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import type { TrinityResult } from '@core/logic/trinity.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { z } from 'zod';
import { parseModelOutputWithSchema } from './safety/aiOutputBoundary.js';

export type ReusableCodeTarget = 'all' | 'asyncHandler' | 'errorResponse' | 'idGenerator';

export interface ReusableCodeGenerationRequest {
  target?: ReusableCodeTarget;
  includeDocs?: boolean;
  language?: 'typescript';
}

export interface ReusableCodeSnippet {
  name: string;
  description: string;
  language: string;
  code: string;
}

export interface ReusableCodeGenerationResult {
  model: string;
  snippets: ReusableCodeSnippet[];
  raw: string;
  meta: ReusableCodeGenerationMeta;
}

export interface ReusableCodeGenerationMeta {
  pipeline: 'trinity';
  bypass: false;
  sourceEndpoint: string;
  classification: 'writing';
  moduleId: 'REUSABLE:CODE';
  requestedAction: 'query';
  executionMode: 'request';
  tokens?: TrinityResult['meta']['tokens'];
  id?: string;
  created?: number;
  tokenLimit?: number;
  outputLimit?: number;
  fallbackFlag?: boolean;
  repairAttempted?: boolean;
  deterministicJsonFallback?: boolean;
  degraded?: boolean;
}

const SUPPORTED_TARGETS: ReusableCodeTarget[] = ['asyncHandler', 'errorResponse', 'idGenerator'];
const reusableCodeResponseSchema = z.object({
  snippets: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      language: z.string().min(1),
      code: z.string().min(1)
    })
  )
});
/**
 * Resolve the requested targets for code generation.
 *
 * @param target - Optional target selector.
 * @returns List of target identifiers to generate.
 * @edgeCases Defaults to all supported targets when no target is specified.
 */
export function resolveReusableTargets(target?: ReusableCodeTarget): ReusableCodeTarget[] {
  //audit Assumption: missing target means generate all; risk: higher token usage; invariant: supported targets only; handling: default to full list.
  if (!target || target === 'all') {
    return [...SUPPORTED_TARGETS];
  }

  //audit Assumption: target is validated upstream; risk: unsupported target reaches here; invariant: target is in supported list; handling: return as single-item list.
  return [target];
}

/**
 * Build the prompt that instructs the OpenAI SDK to generate reusable code snippets.
 *
 * @param request - Generation request details.
 * @returns Prompt string for the OpenAI chat completion call.
 * @edgeCases Ensures defaults are applied for optional fields.
 */
export function buildReusableCodePrompt(request: ReusableCodeGenerationRequest): string {
  const language = request.language ?? 'typescript';
  const includeDocs = request.includeDocs ?? true;
  const targets = resolveReusableTargets(request.target);

  //audit Assumption: prompt assembled with deterministic order; risk: missing targets; invariant: includes each target name once; handling: join by comma.
  const targetList = targets.join(', ');

  return [
    `Generate ${language} code for these reusable utilities: ${targetList}.`,
    'Return JSON only with shape:',
    '{"snippets":[{"name":"","description":"","language":"","code":""}]}',
    'Each snippet must be complete, runnable TypeScript with no hardcoded ports; use environment variables where a value is environment-specific.',
    'Include //audit comments on conditionals, error handling, security checks, and data transforms.',
    includeDocs
      ? 'Add JSDoc for every public function: purpose, inputs/outputs, edge cases.'
      : 'Docstrings are optional; keep code concise.',
    'Do not include markdown fences or extra commentary.'
  ].join(' ');
}

/**
 * Parse the OpenAI JSON response into reusable code snippets.
 *
 * @param raw - Raw JSON string from OpenAI.
 * @returns Structured list of reusable code snippets.
 * @edgeCases Throws when JSON is invalid or missing required fields.
 */
export function parseReusableCodeResponse(raw: string): ReusableCodeSnippet[] {
  const parsed = parseModelOutputWithSchema(raw, reusableCodeResponseSchema, {
    source: 'reusableCodeGeneration.parseReusableCodeResponse'
  });
  return parsed.snippets;
}

function buildReusableCodeRepairPrompt(request: ReusableCodeGenerationRequest, invalidOutput: string): string {
  const invalidPreview =
    invalidOutput.length > 2_000 ? `${invalidOutput.slice(0, 2_000)}...[truncated]` : invalidOutput;

  return [
    'The previous reusable-code response failed JSON parsing.',
    'Regenerate the requested snippets and return strict JSON only.',
    'Required shape: {"snippets":[{"name":"","description":"","language":"","code":""}]}',
    'Do not include markdown fences, prose, caveats, or external-state claims.',
    'Original request:',
    buildReusableCodePrompt(request),
    'Invalid prior output:',
    invalidPreview
  ].join('\n\n');
}

function buildDeterministicReusableCodeSnippets(
  request: ReusableCodeGenerationRequest
): ReusableCodeSnippet[] {
  const language = request.language ?? 'typescript';
  const includeDocs = request.includeDocs ?? true;
  const snippets: Record<ReusableCodeTarget, ReusableCodeSnippet> = {
    asyncHandler: {
      name: 'asyncHandler',
      description: 'Wrap Express async route handlers and forward rejected promises to next().',
      language,
      code: [
        includeDocs
          ? '/** Wraps an async Express handler so rejected promises reach the error middleware. */'
          : '',
        'export function asyncHandler<TReq, TRes, TNext extends (error?: unknown) => void>(',
        '  handler: (req: TReq, res: TRes, next: TNext) => Promise<unknown>',
        ') {',
        '  return (req: TReq, res: TRes, next: TNext): void => {',
        '    //audit Assumption: the framework owns final error serialization; invariant: async failures are never dropped.',
        '    Promise.resolve(handler(req, res, next)).catch(next);',
        '  };',
        '}'
      ].filter(Boolean).join('\n')
    },
    errorResponse: {
      name: 'errorResponse',
      description: 'Build a stable JSON error envelope for HTTP responses.',
      language,
      code: [
        includeDocs
          ? '/** Builds a deterministic, client-safe error response body. */'
          : '',
        'export function errorResponse(code: string, message: string, details?: unknown) {',
        '  //audit Assumption: callers pass already-redacted details; invariant: error shape is stable for clients.',
        '  return {',
        '    ok: false,',
        '    error: {',
        '      code,',
        '      message,',
        '      ...(details === undefined ? {} : { details })',
        '    }',
        '  };',
        '}'
      ].filter(Boolean).join('\n')
    },
    idGenerator: {
      name: 'idGenerator',
      description: 'Generate sortable, prefixed IDs without relying on external services.',
      language,
      code: [
        includeDocs
          ? '/** Generates a prefixed, time-sortable identifier for logs and records. */'
          : '',
        'export function idGenerator(prefix = "id"): string {',
        '  //audit Assumption: crypto.randomUUID is available in supported Node runtimes; invariant: IDs are unique enough for request-scale records.',
        '  const randomPart = crypto.randomUUID().replace(/-/g, "").slice(0, 12);',
        '  return `${prefix}_${Date.now().toString(36)}_${randomPart}`;',
        '}'
      ].filter(Boolean).join('\n')
    },
    all: {
      name: 'all',
      description: 'Internal aggregate placeholder.',
      language,
      code: ''
    }
  };

  return resolveReusableTargets(request.target).map((target) => snippets[target]);
}

function buildReusableCodeMeta(
  trinityResult: Partial<TrinityResult> | undefined,
  fallbackSourceEndpoint: string,
  extras: Partial<ReusableCodeGenerationMeta> = {}
): ReusableCodeGenerationMeta {
  const rawMeta: Partial<TrinityResult['meta']> =
    trinityResult?.meta && typeof trinityResult.meta === 'object'
      ? trinityResult.meta
      : {};

  return {
    ...(rawMeta.tokens ? { tokens: rawMeta.tokens } : {}),
    ...(typeof rawMeta.id === 'string' ? { id: rawMeta.id } : {}),
    ...(typeof rawMeta.created === 'number' ? { created: rawMeta.created } : {}),
    ...(typeof rawMeta.tokenLimit === 'number' ? { tokenLimit: rawMeta.tokenLimit } : {}),
    ...(typeof rawMeta.outputLimit === 'number' ? { outputLimit: rawMeta.outputLimit } : {}),
    pipeline: 'trinity',
    bypass: false,
    sourceEndpoint:
      typeof rawMeta.sourceEndpoint === 'string' && rawMeta.sourceEndpoint.trim().length > 0
        ? rawMeta.sourceEndpoint
        : fallbackSourceEndpoint,
    classification: 'writing',
    moduleId: 'REUSABLE:CODE',
    requestedAction: 'query',
    executionMode: 'request',
    ...(typeof trinityResult?.fallbackFlag === 'boolean'
      ? { fallbackFlag: trinityResult.fallbackFlag }
      : {}),
    ...extras
  };
}

/**
 * Generate reusable code snippets using the Trinity generation facade.
 *
 * @param client - OpenAI SDK client instance.
 * @param request - Generation request details.
 * @returns Generated snippets and metadata.
 * @edgeCases Throws when OpenAI returns invalid JSON.
 */
export async function generateReusableCodeSnippets(
  client: OpenAI,
  request: ReusableCodeGenerationRequest
): Promise<ReusableCodeGenerationResult> {
  const prompt = buildReusableCodePrompt(request);
  const trinityResult = await runTrinityWritingPipeline({
    input: {
      prompt: [
        'You are a senior TypeScript engineer who responds with JSON only.',
        prompt
      ].join('\n\n'),
      moduleId: 'REUSABLE:CODE',
      sourceEndpoint: 'api.reusables',
      requestedAction: 'query',
      body: request,
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
  let raw = trinityResult.result;
  let model = trinityResult.activeModel;
  let snippets: ReusableCodeSnippet[];
  let meta = buildReusableCodeMeta(trinityResult, 'api.reusables');

  try {
    snippets = parseReusableCodeResponse(raw);
  } catch {
    const repairResult = await runTrinityWritingPipeline({
      input: {
        prompt: buildReusableCodeRepairPrompt(request, raw),
        moduleId: 'REUSABLE:CODE',
        sourceEndpoint: 'api.reusables.repair',
        requestedAction: 'query',
        body: {
          request,
          invalidOutputPreview: raw.slice(0, 2_000)
        },
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
    raw = repairResult.result;
    model = repairResult.activeModel;
    meta = buildReusableCodeMeta(repairResult, 'api.reusables.repair', {
      repairAttempted: true
    });
    try {
      snippets = parseReusableCodeResponse(raw);
    } catch {
      snippets = buildDeterministicReusableCodeSnippets(request);
      raw = JSON.stringify({ snippets });
      model = `${model}:deterministic-json-fallback`;
      meta = buildReusableCodeMeta(repairResult, 'api.reusables.repair', {
        repairAttempted: true,
        deterministicJsonFallback: true,
        degraded: true
      });
    }
  }

  return {
    model,
    snippets,
    raw,
    meta
  };
}
