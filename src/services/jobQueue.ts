export type Job = any;

const queue: Job[] = [];
const CONCURRENCY_LIMIT = 3;
let activeJobs = 0;

export function enqueue(job: Job) {
  queue.push(job);
}

async function runClearAudit(job: Job): Promise<any> {
  // Placeholder async logic; replace with real implementation
  await new Promise(resolve => setTimeout(resolve, 1000));
  return job;
}

async function runJob(job: Job) {
  console.log('🚀 Running job:', job);
  try {
    const result = await runClearAudit(job);
    console.log('✅ Finished:', result);
  } catch (err: any) {
    console.error('❌ Error:', err.message);
  } finally {
    activeJobs--;
    processQueue();
  }
}

export function processQueue() {
  while (activeJobs < CONCURRENCY_LIMIT && queue.length > 0) {
    const job = queue.shift()!;
    activeJobs++;
    runJob(job);
  }
}

setInterval(processQueue, 5000);
