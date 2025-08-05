import { reflect } from '../../src/services/ai';
import { getCurrentSleepWindowStatus } from '../../src/services/sleep-config';
export async function checkServerState() {
    const status = getCurrentSleepWindowStatus();
    return status.inSleepWindow ? 'SLEEP_PENDING' : 'ACTIVE';
}
export async function triggerReflectionDump(options) {
    const { mode, reason } = options;
    await reflect({
        label: `${reason}_${mode}_dump_${Date.now()}`,
        persist: true,
        includeStack: true,
        targetPath: `ai_outputs/reflections/${mode}/`
    });
}
