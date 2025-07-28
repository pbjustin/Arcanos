import { KNOWN_WORKERS } from '../utils/worker-validation';
import { registerWorker, safeOrchestrateWorker } from './openai-worker-orchestrator';
import { createServiceLogger } from '../utils/logger';
import { logRoutingRecord } from './diagnostic-registry';

const logger = createServiceLogger('RepeatableOrchestrator');

export interface RoutingRecord {
  worker: string;
  status: 'success' | 'failed';
  timestamp: string;
  error?: string;
}

async function confirmRouting(worker: string): Promise<boolean> {
  try {
    await safeOrchestrateWorker({ name: worker });
    logRoutingRecord({ worker, status: 'success', timestamp: new Date().toISOString() });
    logger.success(`Routing confirmed for ${worker}`);
    return true;
  } catch (err: any) {
    logger.warning(`Routing check failed for ${worker}: ${err.message}`);
    logRoutingRecord({ worker, status: 'failed', timestamp: new Date().toISOString(), error: err.message });
    return false;
  }
}

async function registerAndConfirm(worker: string): Promise<void> {
  try {
    await registerWorker(worker, safeOrchestrateWorker);
    logger.info(`Worker ${worker} re-registered`);
  } catch (err: any) {
    logger.warning(`Registration failed for ${worker}: ${err.message}`);
  }

  const routed = await confirmRouting(worker);
  if (!routed) {
    try {
      await safeOrchestrateWorker({ name: worker });
      logRoutingRecord({ worker, status: 'success', timestamp: new Date().toISOString() });
      logger.success(`Fallback orchestration succeeded for ${worker}`);
    } catch (fallbackErr: any) {
      logger.error(`Fallback orchestration failed for ${worker}`, fallbackErr.message);
      logRoutingRecord({
        worker,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: fallbackErr.message,
      });
    }
  }
}

export async function runOrchestrationCycle(): Promise<void> {
  for (const worker of KNOWN_WORKERS) {
    await registerAndConfirm(worker);
  }
}

export function startRepeatableOrchestration(intervalMs = 60000): void {
  runOrchestrationCycle().catch(err => logger.error('Initial orchestration error', err.message));
  setInterval(() => {
    runOrchestrationCycle().catch(err => logger.error('Orchestration cycle error', err.message));
  }, intervalMs);
  logger.info(`Repeatable orchestration running every ${intervalMs / 1000}s`);
}
