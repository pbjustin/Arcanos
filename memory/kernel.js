const modules = {
  shortterm: require('./modules/shortterm'),
  longterm: require('./modules/longterm'),
  identity: require('./modules/identity'),
  goals: require('./modules/goals'),
  emotions: require('./modules/emotions'),
  threads: require('./modules/threads'),
};

const actions = {
  clearCache: require('./actions/clearCache'),
  updateGoal: require('./actions/updateGoal'),
  hydrateState: require('./actions/hydrateState'),
  bootstrap: require('./actions/bootstrapMemory'),
  sync: require('./actions/syncToPostgres'),
  saveThread: require('./actions/saveThread'),
};

async function dispatch(command, payload = {}) {
  if (command.startsWith('read-')) {
    return modules[payload.type].read();
  }
  if (command.startsWith('write-')) {
    return modules[payload.type].write(payload.data);
  }
  if (actions[command]) return actions[command](payload);
  return { error: 'Unknown memory operation' };
}

module.exports = { dispatch };
