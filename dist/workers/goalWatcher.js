const path = require('path');
const goals = require(path.resolve(__dirname, '../memory/modules/goals'));

module.exports = async function goalWatcher() {
  let list;
  try {
    list = await goals.read();
    console.log('[GOAL WATCHER] Read goals list type:', typeof list, 'isArray:', Array.isArray(list));
  } catch (err) {
    console.error('[GOAL WATCHER] Failed to read goals:', err);
    list = [];
  }

  if (!Array.isArray(list)) {
    console.warn('[GOAL WATCHER] goals.read() returned non-array value', list);
    list = [];
  }

  const pending = list.filter(g => g && !g.completed);
  console.log('[GOAL WATCHER] %d goals active', pending.length);
};
