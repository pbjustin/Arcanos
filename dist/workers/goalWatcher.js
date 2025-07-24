const path = require('path');
const goals = require(path.resolve(__dirname, '../memory/modules/goals'));

module.exports = async function goalWatcher() {
  let list;
  try {
    list = await goals.read();
    console.log('[GOAL WATCHER] list value:', list);
  } catch (err) {
    console.error('[GOAL WATCHER] Failed to read goals:', err);
    list = [];
  }

  let pending = [];
  if (Array.isArray(list)) {
    pending = list.filter(g => g && !g.completed);
  } else {
    console.warn('[GOAL WATCHER] goal list is not an array; skipping filter');
  }

  console.log(`[GOAL WATCHER] ${pending.length} goals active`);
};
