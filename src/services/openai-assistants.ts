import { getOpenAIClient } from './openai.js';

export interface AssistantInfo {
  id: string;
  name: string | null;
  instructions: string | null;
  tools: any[] | null;
}

/**
 * Fetch all assistants from OpenAI with pagination support.
 */
export async function getAllAssistants(): Promise<AssistantInfo[]> {
  const client = getOpenAIClient();
  if (!client) throw new Error('OpenAI client not initialized');

  const assistants: AssistantInfo[] = [];
  let cursor: string | undefined = undefined;

  while (true) {
    const resp = await client.beta.assistants.list({ limit: 20, after: cursor });
    resp.data.forEach(a => {
      assistants.push({
        id: a.id,
        name: a.name ?? null,
        instructions: a.instructions ?? null,
        tools: a.tools ?? null
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
    }
  }

  return lookup;
}

/**
 * Call an assistant by its name with a single message.
 */
export async function callAssistantByName(name: string, message: string) {
  const client = getOpenAIClient();
  if (!client) throw new Error('OpenAI client not initialized');

  const lookup = await buildAssistantLookup();
  const assistantId = lookup[name.toLowerCase()];

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
  callAssistantByName
};

export default openAIAssistantsService;
