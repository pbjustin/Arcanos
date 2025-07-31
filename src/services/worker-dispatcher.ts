export interface DispatchOptions {
  worker: string;
  service: 'memory' | 'api' | string;
  task: any;
  manualOverride?: boolean;
}

/**
 * Dispatch tasks to specific workers with AI-defined routing logic.
 * Fallback to the default worker is disabled unless `manualOverride` is set.
 */
export async function dispatchTask(options: DispatchOptions): Promise<void> {
  const { worker, service, task, manualOverride } = options;

  // Disable fallback to defaultWorker unless manually triggered
  if (worker === 'defaultWorker' && !manualOverride) {
    throw new Error(
      'Fallback to defaultWorker is disabled. Define a specific worker.'
    );
  }

  switch (service) {
    case 'memory':
      await import('../workers/memorySync').then((w) => w.default(task));
      break;
    case 'api':
      await import('../workers/api').then((w) => w.handle(task));
      break;
    default:
      throw new Error(`Unrecognized service: ${service}`);
  }

  if (manualOverride && worker === 'defaultWorker') {
    console.warn('[OVERRIDE] Executing fallback defaultWorker...');
    await import('../workers/clearTemp').then((w) => w.default(task));
  }
}
