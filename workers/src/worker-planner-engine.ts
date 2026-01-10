import type { WorkerContext } from './workerTypes.js';

export const id = 'worker-planner-engine';
export const description = 'Coordinates scheduled worker runs and monitors pending jobs.';
export const schedule = '*/5 * * * *';

async function inspectJobQueue(context: WorkerContext) {
  try {
    const result = await context.db.query(
      'SELECT COUNT(*)::int AS count FROM job_data WHERE status = $1',
      ['pending']
    );
    const row = result?.rows?.[0] as { count?: number | string } | undefined;
    const count = row?.count;
    const pending = typeof count === 'number' ? count : Number(count ?? 0);
    await context.log(`Planner heartbeat complete (pending=${pending})`);
    return pending;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.error('Failed to inspect job queue', message);
    return 0;
  }
}

export default {
  id,
  name: 'Planner Engine',
  description,
  schedule,
  async run(context: WorkerContext) {
    const startedAt = new Date().toISOString();
    await context.log(`Planner cycle started at ${startedAt}`);

    const pendingJobs = await inspectJobQueue(context);

    return {
      workerId: id,
      status: 'ok',
      checkedAt: startedAt,
      pendingJobs
    };
  }
};
