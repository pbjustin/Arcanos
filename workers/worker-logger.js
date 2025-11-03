export const id = 'worker-logger';
export const description = 'Initializes the centralized worker execution logger.';

export async function run() {
  const timestamp = new Date().toISOString();
  console.log(`[${id}] Logger ready at ${timestamp}`);
  return {
    workerId: id,
    status: 'ready',
    initializedAt: timestamp
  };
}

export default {
  id,
  name: 'Worker Logger',
  description,
  async run(context) {
    const timestamp = new Date().toISOString();
    if (context?.log) {
      await context.log(`Logger heartbeat at ${timestamp}`);
    } else {
      console.log(`[${id}] Logger heartbeat at ${timestamp}`);
    }

    return {
      workerId: id,
      status: 'ok',
      heartbeatAt: timestamp
    };
  }
};
