const path = require('path');
const goals = require(path.resolve(__dirname, '../memory/modules/goals'));

module.exports = async function goalWatcher() {
  const list = goals.read();
  const pending = list.filter(g => !g.completed);
  console.log(`[GOAL WATCHER] ${pending.length} goals active`);
};
