import type OpenAI from 'openai';
import fs from 'fs/promises';
import { getOpenAIClient } from './openai.js';
import config from '../config/index.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { writeJsonFile } from '../utils/fileStorage.js';

export interface AssistantInfo {
  id: string;
  name: string | null;
  instructions: string | null;
  tools: any[] | null;
  model?: string | null;
}

export interface AssistantRecord extends AssistantInfo {
  normalizedName: string;
}

export type AssistantRegistry = Record<string, AssistantRecord>;

type AssistantListPage = Awaited<ReturnType<OpenAI['beta']['assistants']['list']>>;

const LOG_CONTEXT = { module: 'assistant-sync' } as const;
const REGISTRY_PATH = config.assistantSync.registryPath;

/**
 * Fetch all assistants from OpenAI with pagination support.
 */
export async function getAllAssistants(): Promise<AssistantInfo[]> {
  const client = getOpenAIClient();
  if (!client) throw new Error('OpenAI client not initialized');

  const assistants: AssistantInfo[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    const resp: AssistantListPage = await client.beta.assistants.list({ limit: 20, after: cursor });
    resp.data.forEach((a: any) => {
      assistants.push({
        id: a.id,
        name: a.name ?? null,
        instructions: a.instructions ?? null,
        tools: a.tools ?? null,
        model: a.model ?? null
      });
    });

    if (!resp.has_more) break;
    cursor = (resp as any).last_id || undefined;
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      aiLogger.warn('[AI-ASSISTANT-SYNC] Failed to read assistant registry', LOG_CONTEXT, {
        path: REGISTRY_PATH,
        message: error instanceof Error ? error.message : String(error)
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
  } catch (error) {
    aiLogger.error('[AI-ASSISTANT-SYNC] Failed to sync assistants', context, undefined, error as Error);
    return loadAssistantRegistry();
  } finally {
    endTimer();
  }
}

/**
 * Call an assistant by its name with a single message.
 */
export async function callAssistantByName(name: string, message: string) {
  const client = getOpenAIClient();
  if (!client) throw new Error('OpenAI client not initialized');

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

  return (client as any).beta.threads.create({
    assistant_id: assistantId,
    messages: [{ role: 'user', content: message }]
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
