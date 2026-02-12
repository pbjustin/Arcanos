import type OpenAI from 'openai';
import { getDefaultModel } from './openai/credentialProvider.js';
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
    'Each snippet must be complete, runnable, and Railway-ready (no hardcoded ports, use envs).',
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

/**
 * Generate reusable code snippets using the OpenAI SDK.
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
  const model = getDefaultModel();
  const prompt = buildReusableCodePrompt(request);

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: 'You are a senior TypeScript engineer who responds with JSON only.'
      },
      {
        role: 'user',
        content: prompt
      }
    ],
    temperature: 0.2
  });

  const rawContent = response.choices?.[0]?.message?.content ?? '';
  //audit Assumption: OpenAI returns content; risk: empty response; invariant: non-empty string; handling: throw error if empty.
  if (!rawContent.trim()) {
    throw new Error('OpenAI response contained no content.');
  }

  const snippets = parseReusableCodeResponse(rawContent);

  return {
    model: response.model ?? model,
    snippets,
    raw: rawContent
  };
}
