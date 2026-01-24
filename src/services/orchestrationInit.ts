import { appendFileSync, mkdirSync } from 'fs';

export interface GPT5OrchestrationConfig {
  memoryContextEnabled?: boolean;
  contextSnapshotTag?: string;
  agentId: string;
  sessionId: string;
  [key: string]: unknown;
}

export async function initializeGPT5Orchestration(config: GPT5OrchestrationConfig): Promise<void> {
  try {
    config.memoryContextEnabled = true;

    //audit Assumption: missing snapshot tag should default
    if (!config.contextSnapshotTag) {
      config.contextSnapshotTag = process.env.CONTEXT_SNAPSHOT_TAG || 'orchestration';
    }

    //audit Assumption: agentId and sessionId are required
    if (!config.agentId || !config.sessionId) {
      throw new Error('Missing agentId or sessionId for GPT-5.1 init');
    }

    let attached = false;
    for (let i = 0; i < 2; i++) {
      attached = await attachMemoryContext(config);
      if (attached) break;
      console.warn('[GPT5-INIT] Retrying GPT-5.1 memory context attachment...');
    }

    //audit Assumption: failure to attach should halt orchestration init
    if (!attached) {
      throw new Error('GPT-5.1 memory context failed to attach');
    }

    console.log('✅ [GPT5-INIT] Memory context attached successfully');
    logEvent('GPT-5.1 memory context attached', config);
  } catch (err: unknown) {
    //audit Assumption: orchestration init errors should be surfaced
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('❌ [GPT5-INIT] Orchestration init failed:', errorMessage);
    logEvent('GPT-5.1 orchestration init failure', { error: errorMessage });
    throw err;
  }
}

async function attachMemoryContext(_config: GPT5OrchestrationConfig): Promise<boolean> {
  // Placeholder for existing memory attachment logic
  return true;
}

function logEvent(message: string, details: unknown) {
  try {
    mkdirSync('/logs', { recursive: true });
    appendFileSync('/logs/orchestration.log', `${new Date().toISOString()} - ${message} - ${JSON.stringify(details)}\n`);
  } catch (error: unknown) {
    //audit Assumption: logging failures should not crash flow
    console.error('❌ Failed to write orchestration log:', error instanceof Error ? error.message : error);
  }
}

