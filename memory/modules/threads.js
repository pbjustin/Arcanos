const shortterm = require('./shortterm');
const { logEvent } = require('../logEvent');

module.exports = {
  async read() {
    const data = await shortterm.read();
    return data.threads || {};
  },
  async write(threads) {
    const data = await shortterm.read();
    data.threads = threads;
    await shortterm.write(data);
    await logEvent('threads');
  },
  async save(id, thread) {
    const threads = await this.read();
    threads[id] = thread;
    await this.write(threads);
    return { saved: true, id };
  },
};
