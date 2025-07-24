const path = require('path');
const goals = require(path.resolve(__dirname, '../memory/modules/goals'));

module.exports = async function goalWatcher() {
  // Ensure the goals module returns an array before filtering
  let list = await goals.read();
  if (!Array.isArray(list)) {
    list = [];
  }
  const pending = list.filter(g => !g.completed);
  console.log(`[GOAL WATCHER] ${pending.length} goals active`);
};
