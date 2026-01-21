import { EventEmitter } from 'events';
import type { JobHandler, JobName, JobResultMap, JobPayload } from '../jobs/index.js';

export class TypedWorkerQueue extends EventEmitter {
  register<T extends JobName>(job: T, handler: JobHandler<T>): void {
    this.on(job, handler);
  }

  async dispatch<T extends JobName>(
    job: T,
    payload: JobPayload<T>,
    options: { attempts?: number; backoffMs?: number } = {}
  ): Promise<JobResultMap[T][]> {
    const listeners = this.listeners(job) as JobHandler<T>[];
    const { attempts = 3, backoffMs = 500 } = options;
    const results: JobResultMap[T][] = [];

    for (const listener of listeners) {
      let attempt = 0;
      let delay = backoffMs;

      while (attempt < attempts) {
        try {
          const result = await listener({ type: job, payload });
          results.push(result);
          break;
        } catch (error) {
          attempt += 1;
          if (attempt >= attempts) {
            throw error;
          }
          await new Promise<void>(resolve => {
            const timeout = setTimeout(resolve, delay);
            if (typeof timeout.unref === 'function') timeout.unref();
          });
          delay *= 2;
        }
      }
    }

    return results;
  }
}
