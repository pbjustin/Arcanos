const shortterm = require('../memory/modules/shortterm');

module.exports = {
  async set(key, value) {
    const data = await shortterm.read();
    data[key] = value;
    await shortterm.write(data);
    return { key, value };
  },

  async get(key) {
    const data = await shortterm.read();
    return data[key];
  }
};
