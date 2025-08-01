import { onServerSleep } from './events/system-events';
import { triggerSelfReflection } from './services/reflection-engine';

onServerSleep(() => {
  console.log('[Reflection Trigger] Server is entering sleep mode. Initiating reflection...');
  triggerSelfReflection({
    source: 'server-sleep',
    force: true,
    log: true,
    memoryTarget: 'long-term'
  });
});
