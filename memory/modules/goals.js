const shortterm = require('./shortterm');
const { logEvent } = require('../logEvent');

module.exports = {
  async read() {
    const data = await shortterm.read();
    return data.goals || [];
  },
  async write(goals) {
    const data = await shortterm.read();
    data.goals = goals;
    await shortterm.write(data);
    await logEvent('goals');
  },
};
