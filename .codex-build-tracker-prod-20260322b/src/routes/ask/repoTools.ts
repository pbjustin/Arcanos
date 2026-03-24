import type OpenAI from 'openai';
import { z } from 'zod';

import { invokeTool } from '@arcanos/cli/client';
import { buildFunctionToolSet, type FunctionToolDefinition } from '@services/openai/functionTools.js';
import { parseToolArgumentsWithSchema } from '@services/safety/aiOutputBoundary.js';
import { shouldInspectRepoPrompt } from '@services/repoImplementationEvidence.js';

import {
  buildToolAskResponse,
  runAskToolMode,
  type ToolExecutionResult,
} from './toolRuntime.js';
import type { AskResponse } from './types.js';

const REPO_TOOL_SYSTEM_PROMPT = [
  'You are ARCANOS in repository inspection mode.',
  'Use repository tools when the operator is asking what is implemented, what files exist, what commands are present, whether a feature is scaffolded, or what changed in the repository.',
  'Use doctor_implementation first for broad implementation-status or scaffold questions.',
  'Use repo_list_tree to inspect directory structure, repo_search to locate symbols or commands, and repo_read_file to inspect exact source when needed.',
  'Use repo_get_status only for working tree status questions and repo_get_log only for recent history questions.',
  'Base the answer only on tool results. If the prompt is not about repository inspection, do not call any tools.',
].join(' ');

const repoToolDefinitions: FunctionToolDefinition[] = [
  {
    name: 'doctor_implementation',
    description: 'Diagnose implementation coverage from direct repository inspection evidence.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'repo_list_tree',
    description: 'List files and directories from the active workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional relative path to inspect.' },
        depth: { type: 'integer', minimum: 1, maximum: 8 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      }
    }
  },
  {
    name: 'repo_read_file',
    description: 'Read UTF-8 file content from the active workspace root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to read.' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        maxBytes: { type: 'integer', minimum: 1, maximum: 200000 }
      },
      required: ['path']
    }
  },
  {
    name: 'repo_search',
    description: 'Search text or symbols across the active workspace root.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or symbol query to search for.' },
        path: { type: 'string', description: 'Optional relative search root.' },
        type: { type: 'string', enum: ['text', 'symbol'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      },
      required: ['query']
    }
  },
  {
    name: 'repo_get_status',
    description: 'Read repository status using read-only git inspection.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'repo_get_log',
    description: 'Read recent repository commits using read-only git inspection.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 }
      }
    }
  }
];

const {
  chatCompletionTools: repoChatCompletionTools,
  responsesTools: repoResponsesTools,
} = buildFunctionToolSet(repoToolDefinitions);

const repoListTreeArgsSchema = z.object({
  path: z.string().trim().min(1).optional(),
  depth: z.number().int().min(1).max(8).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const repoReadFileArgsSchema = z.object({
  path: z.string().trim().min(1),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  maxBytes: z.number().int().min(1).max(200000).optional(),
});

const repoSearchArgsSchema = z.object({
  query: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
  type: z.enum(['text', 'symbol']).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const repoGetLogArgsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

type RepoToolName =
  | 'doctor_implementation'
  | 'repo_list_tree'
  | 'repo_read_file'
  | 'repo_search'
  | 'repo_get_status'
  | 'repo_get_log';

function summarizeRepoEntries(entries: unknown): string {
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'no entries';
  }

  return entries
    .slice(0, 6)
    .map((entry) => {
      const typedEntry = entry as { path?: string; entryType?: string };
      return `${typedEntry.path ?? 'unknown'}${typedEntry.entryType ? ` (${typedEntry.entryType})` : ''}`;
    })
    .join(', ');
}

function summarizeRepoSearchMatches(matches: unknown): string {
  if (!Array.isArray(matches) || matches.length === 0) {
    return 'no matches';
  }

  return matches
    .slice(0, 4)
    .map((match) => {
      const typedMatch = match as { path?: string; line?: number; preview?: string };
      return `${typedMatch.path ?? 'unknown'}:${typedMatch.line ?? '?'} ${typedMatch.preview ?? ''}`.trim();
    })
    .join(' | ');
}

function summarizeRepoToolExecution(toolName: RepoToolName, payload: Record<string, unknown>): string {
  switch (toolName) {
    case 'doctor_implementation':
      return `Implementation doctor status=${payload.status ?? 'unknown'}.`;
    case 'repo_list_tree':
      return `Repository tree at ${payload.path ?? '.'}: ${summarizeRepoEntries(payload.entries)}.`;
    case 'repo_read_file': {
      const content = typeof payload.content === 'string' ? payload.content.slice(0, 180) : '';
      return `Read ${payload.path ?? 'file'} lines ${Array.isArray(payload.range) ? payload.range.join('-') : 'unknown'}: ${content}`.trim();
    }
    case 'repo_search':
      return `Repository search for "${payload.query ?? ''}": ${summarizeRepoSearchMatches(payload.matches)}.`;
    case 'repo_get_status':
      return `Repository status: branch=${payload.branch ?? 'unknown'}, clean=${payload.clean ?? 'unknown'}, changes=${Array.isArray(payload.changes) ? payload.changes.length : 0}.`;
    case 'repo_get_log': {
      const commits = Array.isArray(payload.commits) ? payload.commits : [];
      const subjects = commits
        .slice(0, 3)
        .map((commit) => (commit as { subject?: string }).subject ?? 'unknown')
        .join(' | ');
      return `Recent commits: ${subjects || 'none'}.`;
    }
    default:
      return `Executed ${toolName}.`;
  }
}

async function executeRepoTool(toolName: RepoToolName, rawArgs: string): Promise<ToolExecutionResult> {
  switch (toolName) {
    case 'doctor_implementation': {
      const output = await invokeTool({ toolId: 'doctor.implementation', inputs: {} }) as Record<string, unknown>;
      return { output, summary: summarizeRepoToolExecution(toolName, output) };
    }
    case 'repo_list_tree': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, repoListTreeArgsSchema, 'repoTools.repo_list_tree');
      const output = await invokeTool({ toolId: 'repo.listTree', inputs: parsedArgs }) as Record<string, unknown>;
      return { output, summary: summarizeRepoToolExecution(toolName, output) };
    }
    case 'repo_read_file': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, repoReadFileArgsSchema, 'repoTools.repo_read_file');
      const output = await invokeTool({ toolId: 'repo.readFile', inputs: parsedArgs }) as Record<string, unknown>;
      return { output, summary: summarizeRepoToolExecution(toolName, output) };
    }
    case 'repo_search': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, repoSearchArgsSchema, 'repoTools.repo_search');
      const { query, path, type, offset, limit } = parsedArgs;
      const output = await invokeTool({
        toolId: 'repo.search',
        inputs: {
          query,
          options: {
            ...(path ? { path } : {}),
            ...(type ? { type } : {}),
            ...(offset !== undefined ? { offset } : {}),
            ...(limit !== undefined ? { limit } : {}),
          }
        }
      }) as Record<string, unknown>;
      return { output, summary: summarizeRepoToolExecution(toolName, output) };
    }
    case 'repo_get_status': {
      const output = await invokeTool({ toolId: 'repo.getStatus', inputs: {} }) as Record<string, unknown>;
      return { output, summary: summarizeRepoToolExecution(toolName, output) };
    }
    case 'repo_get_log': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, repoGetLogArgsSchema, 'repoTools.repo_get_log');
      const output = await invokeTool({ toolId: 'repo.getLog', inputs: parsedArgs }) as Record<string, unknown>;
      return { output, summary: summarizeRepoToolExecution(toolName, output) };
    }
    default:
      throw new Error(`Unsupported repo tool: ${toolName}`);
  }
}

/**
 * Attempt to let `/ask` answer repository implementation questions through protocol repo tools.
 *
 * Purpose:
 * - Give the primary ask route a tool-aware repository inspection path instead of relying only on generic Trinity chat.
 *
 * Inputs/outputs:
 * - Input: OpenAI client and prompt text.
 * - Output: repo-tool AskResponse when repo tools execute; `null` when the prompt should continue through normal ask routing.
 *
 * Edge case behavior:
 * - Non-repository prompts return `null` so existing ask orchestration remains unchanged.
 */
export async function tryDispatchRepoTools(
  client: OpenAI,
  prompt: string,
): Promise<AskResponse | null> {
  if (!shouldInspectRepoPrompt(prompt)) {
    return null;
  }

  return runAskToolMode({
    client,
    prompt,
    instructions: REPO_TOOL_SYSTEM_PROMPT,
    moduleName: 'repo-tools',
    responseIdPrefix: 'repo-tool',
    chatCompletionTools: repoChatCompletionTools,
    responsesTools: repoResponsesTools,
    executeTool: (toolName, rawArgs) => executeRepoTool(toolName as RepoToolName, rawArgs),
    maxOutputTokens: 768,
  });
}

export function buildRepoToolAskResponse(resultText: string): AskResponse {
  return buildToolAskResponse('repo-tools', null, resultText, 'repo-tool');
}
