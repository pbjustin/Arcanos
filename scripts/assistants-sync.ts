import OpenAI from 'openai';

// Endpoint for ARCANOS plugin to receive assistant data
const SYNC_ENDPOINT = process.env.ASSISTANTS_SYNC_ENDPOINT || 'http://localhost:3000/assistants-sync';

// Interval in milliseconds for polling OpenAI Assistants API
const POLL_INTERVAL = 60_000; // 60 seconds

interface AssistantPayload {
  id: string;
  name: string | null;
  instructions: string | null;
  tools: any[] | null;
}

async function listOpenAIAssistants(openai: OpenAI) {
  const response = await openai.beta.assistants.list();
  return response.data.map(a => ({
    id: a.id,
    name: a.name ?? null,
    instructions: a.instructions ?? null,
    tools: a.tools ?? null
  }) as AssistantPayload);
}

async function getLocalAssistants(): Promise<AssistantPayload[]> {
  try {
    const res = await fetch(SYNC_ENDPOINT);
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.assistants) ? json.assistants : [];
  } catch {
    // If the endpoint is unreachable, treat as no local assistants
    return [];
  }
}

function assistantsDiffer(local: AssistantPayload[], remote: AssistantPayload[]) {
  if (local.length !== remote.length) return true;
  const map = new Map(local.map(a => [a.id, JSON.stringify(a)]));
  return remote.some(a => map.get(a.id) !== JSON.stringify(a));
}

async function syncAssistants() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set');
    return;
  }

  const openai = new OpenAI({ apiKey });

  try {
    const remoteAssistants = await listOpenAIAssistants(openai);
    const localAssistants = await getLocalAssistants();

    if (!assistantsDiffer(localAssistants, remoteAssistants)) {
      console.log('Assistants already in sync');
      return;
    }

    const res = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assistants: remoteAssistants })
    });

    if (res.ok) {
      console.log(`Synced ${remoteAssistants.length} assistants`);
    } else {
      console.error(`Sync failed with status ${res.status}`);
    }
  } catch (err) {
    console.error('Assistant sync error:', err);
  }
}

// Initial sync and interval polling
syncAssistants();
setInterval(syncAssistants, POLL_INTERVAL);
