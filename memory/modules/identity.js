const shortterm = require('./shortterm');
const { logEvent } = require('../logEvent');

module.exports = {
  async read() {
    const data = await shortterm.read();
    return data.identity || {};
  },
  async write(identity) {
    const data = await shortterm.read();
    data.identity = identity;
    await shortterm.write(data);
    await logEvent('identity');
  },
};
