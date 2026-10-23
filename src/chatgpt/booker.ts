import { invokeBookerGptAction } from './bookerGptAdapter.js';
import { createBookerMcpExecutorCore, type BookerMcpServices } from './bookerCore.js';

export * from './bookerCore.js';

/** Production adapters retain the canonical route, readers and protected job-result boundary. */
export function createBookerMcpExecutor(overrides: Partial<BookerMcpServices> = {}) {
  return createBookerMcpExecutorCore({
    run: invokeBookerGptAction,
    universe: async universeId => (await import('@services/backstageUniverseRead.js')).readBackstageUniverse(universeId),
    storyline: async (universeId, storylineKey, options) => (await import('@services/backstageUniverseRead.js')).readBackstageStorylineSummary(universeId, storylineKey, options),
    job: async (input, dependencies) => (await import('../routes/backstageBookerAsyncResult.js')).readBackstageBookerAsyncResult(input, dependencies),
    getJobById: async jobId => (await import('@core/db/repositories/jobRepository.js')).getJobById(jobId),
    ...overrides,
  });
}

export const executeBookerMcp = createBookerMcpExecutor();
