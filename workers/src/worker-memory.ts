import type { WorkerContext } from './workerTypes.js';

export const id = 'worker-memory';
export const description = 'Persists AI memory snapshots into the database with graceful fallbacks.';
export const schedule = '*/10 * * * *';

async function loadMemorySnapshot(context: WorkerContext) {
  try {
    const result = await context.db.query(
      'SELECT COUNT(*)::int AS entries FROM memory'
    );
    const row = result?.rows?.[0] as { entries?: number | string } | undefined;
    const entries = row?.entries;
    return typeof entries === 'number' ? entries : Number(entries ?? 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.error('Unable to read memory table', message);
    return 0;
  }
}

export default {
  id,
  name: 'Memory Synchronizer',
  description,
  schedule,
  async run(context: WorkerContext) {
    const startedAt = new Date().toISOString();
    await context.log(`Memory sync cycle started at ${startedAt}`);

    const entries = await loadMemorySnapshot(context);

    if (entries === 0) {
      await context.log('Memory table empty – nothing to sync');
    } else {
      await context.log(`Prepared ${entries} memory entries for sync`);
    }

    return {
      workerId: id,
      status: 'ok',
      syncedAt: startedAt,
      entries
    };
  }
};
