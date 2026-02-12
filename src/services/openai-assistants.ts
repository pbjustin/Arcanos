import type OpenAI from 'openai';
import fs from 'fs/promises';
import { config } from "@platform/runtime/config.js";
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { writeJsonFile } from "@shared/fileStorage.js";
import { requireOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { resolveErrorMessage } from "@core/lib/errors/index.js";

export interface AssistantInfo {
  id: string;
  name: string | null;
  instructions: string | null;
  tools: OpenAI.Beta.Assistants.Assistant['tools'] | null;
  model?: string | null;
}

export interface AssistantRecord extends AssistantInfo {
  normalizedName: string;
}

export type AssistantRegistry = Record<string, AssistantRecord>;

type AssistantListPage = Awaited<ReturnType<OpenAI['beta']['assistants']['list']>>;
type AssistantEntry = AssistantListPage['data'][number];

const LOG_CONTEXT = { module: 'assistant-sync' } as const;
const REGISTRY_PATH = config.assistantSync.registryPath;
const ASSISTANT_LIST_PAGE_LIMIT = 20;

/**
 * Fetch all assistants from OpenAI with pagination support.
 */
export async function getAllAssistants(): Promise<AssistantInfo[]> {
  const { client } = requireOpenAIClientOrAdapter('OpenAI adapter not initialized');

  const assistants: AssistantInfo[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    const resp: AssistantListPage = await client.beta.assistants.list({ limit: ASSISTANT_LIST_PAGE_LIMIT, after: cursor });
    resp.data.forEach((a: AssistantEntry) => {
      assistants.push({
        id: a.id,
        name: a.name ?? null,
        instructions: a.instructions ?? null,
        tools: a.tools ?? null,
        model: a.model ?? null
      });
    });

    if (!resp.has_more) break;
    cursor = typeof (resp as { last_id?: unknown }).last_id === 'string'
      ? (resp as { last_id?: string }).last_id
      : undefined;
  }

  return assistants;
}

/**
 * Build a lookup table mapping assistant names to IDs.
 */
export async function buildAssistantLookup(): Promise<Record<string, string>> {
  const assistants = await getAllAssistants();
  const lookup: Record<string, string> = {};

  for (const assistant of assistants) {
    if (assistant.name) {
      lookup[assistant.name.toLowerCase()] = assistant.id;
      const normalized = normalizeAssistantName(assistant.name);
      if (normalized) {
        lookup[normalized.toLowerCase()] = assistant.id;
      }
    }
  }

  return lookup;
}

export function normalizeAssistantName(name: string | null | undefined): string | null {
  if (!name) return null;
  const sanitized = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) return null;

  return sanitized.replace(/\s+/g, '_').toUpperCase();
}

export async function loadAssistantRegistry(): Promise<AssistantRegistry> {
  try {
    const content = await fs.readFile(REGISTRY_PATH, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AssistantRegistry;
    }
    aiLogger.warn('[AI-ASSISTANT-SYNC] Invalid registry content encountered, resetting', LOG_CONTEXT, {
      path: REGISTRY_PATH
    });
    await saveAssistantRegistry({});
    return {};
  } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      aiLogger.warn('[AI-ASSISTANT-SYNC] Failed to read assistant registry', LOG_CONTEXT, {
        path: REGISTRY_PATH,
        message: resolveErrorMessage(error)
      });
    } else {
      await saveAssistantRegistry({});
      return {};
    }
  }

  return {};
}

export async function saveAssistantRegistry(registry: AssistantRegistry): Promise<void> {
  await writeJsonFile(REGISTRY_PATH, registry);
}

export async function getAssistantRegistry(): Promise<AssistantRegistry> {
  return loadAssistantRegistry();
}

export async function getAssistantNames(): Promise<string[]> {
  const registry = await getAssistantRegistry();
  return Object.keys(registry).sort();
}

export async function getAssistant(name: string): Promise<AssistantRecord | undefined> {
  const registry = await getAssistantRegistry();

  if (registry[name]) {
    return registry[name];
  }

  const normalized = normalizeAssistantName(name);
  if (normalized && registry[normalized]) {
    return registry[normalized];
  }

  const lowerName = name.toLowerCase();
  return Object.values(registry).find((record) => record.name?.toLowerCase() === lowerName);
}

function mapAssistantsToRegistry(assistants: AssistantInfo[]): AssistantRegistry {
  const registry: AssistantRegistry = {};
  for (const assistant of assistants) {
    if (!assistant.name) continue;
    const normalizedName = normalizeAssistantName(assistant.name);
    if (!normalizedName) continue;

    registry[normalizedName] = {
      ...assistant,
      normalizedName
    };
  }
  return registry;
}

export async function syncAssistantRegistry(): Promise<AssistantRegistry> {
  const context = { ...LOG_CONTEXT, operation: 'sync' };
  const endTimer = aiLogger.startTimer('assistant-sync', context);
  try {
    const assistants = await getAllAssistants();
    const registry = mapAssistantsToRegistry(assistants);
    await saveAssistantRegistry(registry);
    aiLogger.info('[AI-ASSISTANT-SYNC] Registry updated', context, {
      count: Object.keys(registry).length,
      names: Object.keys(registry)
    });
    return registry;
  } catch (error: unknown) {
    //audit Assumption: sync failure should fall back to stored registry
    aiLogger.error('[AI-ASSISTANT-SYNC] Failed to sync assistants', context, undefined, error instanceof Error ? error : undefined);
    return loadAssistantRegistry();
  } finally {
    endTimer();
  }
}

/**
 * Call an assistant by its name with a single message.
 */
export async function callAssistantByName(name: string, message: string) {
  const { client } = requireOpenAIClientOrAdapter('OpenAI adapter not initialized');

  const normalized = normalizeAssistantName(name);
  const registry = await getAssistantRegistry();

  let assistantId = normalized ? registry[normalized]?.id : undefined;

  if (!assistantId) {
    const lowerName = name.toLowerCase();
    for (const record of Object.values(registry)) {
      if (record.name && record.name.toLowerCase() === lowerName) {
        assistantId = record.id;
        break;
      }
    }
  }

  if (!assistantId) {
    const freshRegistry = await syncAssistantRegistry();
    assistantId = normalized ? freshRegistry[normalized]?.id : undefined;

    if (!assistantId) {
      const lowerName = name.toLowerCase();
      for (const record of Object.values(freshRegistry)) {
        if (record.name && record.name.toLowerCase() === lowerName) {
          assistantId = record.id;
          break;
        }
      }
    }
  }

  if (!assistantId) {
    const lookup = await buildAssistantLookup();
    assistantId = lookup[name.toLowerCase()];
    if (!assistantId && normalized) {
      assistantId = lookup[normalized.toLowerCase()];
    }
  }

  if (!assistantId) {
    throw new Error(`Assistant '${name}' not found.`);
  }

  const thread = await client.beta.threads.create({
    messages: [{ role: 'user', content: message }]
  });
  return client.beta.threads.runs.create(thread.id, {
    assistant_id: assistantId
  });
}

export const openAIAssistantsService = {
  getAllAssistants,
  buildAssistantLookup,
  callAssistantByName,
  normalizeAssistantName,
  getAssistantRegistry,
  getAssistantNames,
  getAssistant,
  syncAssistantRegistry
};

export default openAIAssistantsService;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
