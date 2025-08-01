import { schedule } from 'node-cron';
import { triggerReflectionDump, checkServerState } from '../services/reflection-engine';

// Run every hour on the hour
schedule('0 * * * *', async () => {
  const state = await checkServerState();

  if (state === 'ACTIVE') {
    console.log('[Reflection] Running periodic hourly reflection...');
    await triggerReflectionDump({ mode: 'incremental', reason: 'hourly' });
  } else if (state === 'SLEEP_PENDING') {
    console.log('[Reflection] Server sleep detected — performing full memory sweep.');
    await triggerReflectionDump({ mode: 'full', reason: 'server_shutdown' });
  }
});
