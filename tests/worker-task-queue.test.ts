import { WorkerTaskQueue } from '../src/config/workerConfig.js';

test('dispatch retries failing task with exponential backoff', async () => {
  const queue = new WorkerTaskQueue();
  let attempts = 0;
  queue.register(async () => {
    attempts++;
    if (attempts < 3) {
      throw new Error('fail');
    }
  });

  await queue.dispatch('test', { attempts: 3, backoffMs: 10 });
  expect(attempts).toBe(3);
});
