import { reflect } from '../../src/services/ai';
import { getCurrentSleepWindowStatus } from '../../src/services/sleep-config';

export type ServerState = 'ACTIVE' | 'SLEEP_PENDING';

export interface ReflectionDumpOptions {
  mode: 'incremental' | 'full';
  reason: string;
}

export async function checkServerState(): Promise<ServerState> {
  const status = getCurrentSleepWindowStatus();
  return status.inSleepWindow ? 'SLEEP_PENDING' : 'ACTIVE';
}

export async function triggerReflectionDump(options: ReflectionDumpOptions): Promise<void> {
  const { mode, reason } = options;
  await reflect({
    label: `${reason}_${mode}_dump_${Date.now()}`,
    persist: true,
    includeStack: true,
    targetPath: `ai_outputs/reflections/${mode}/`
  });
}
