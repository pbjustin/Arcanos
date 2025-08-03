import shortterm from './modules/shortterm.js';
import longterm from './modules/longterm.js';
import identity from './modules/identity.js';
import goals from './modules/goals.js';
import emotions from './modules/emotions.js';
import threads from './modules/threads.js';
import manifest from './modules/manifest.js';

import clearCache from './actions/clearCache.js';
import updateGoal from './actions/updateGoal.js';
import hydrateState from './actions/hydrateState.js';
import bootstrap from './actions/bootstrapMemory.js';
import sync from './actions/syncToPostgres.js';
import saveThread from './actions/saveThread.js';

const modules = {
  shortterm,
  longterm,
  identity,
  goals,
  emotions,
  threads,
  manifest,
};

const actions = {
  clearCache,
  updateGoal,
  hydrateState,
  bootstrap,
  sync,
  saveThread,
};

export async function dispatch(command, payload = {}) {
  if (command.startsWith('read-')) {
    return modules[payload.type].read();
  }
  if (command.startsWith('write-')) {
    return modules[payload.type].write(payload.data);
  }
  if (actions[command]) return actions[command](payload);
  return { error: 'Unknown memory operation' };
}
