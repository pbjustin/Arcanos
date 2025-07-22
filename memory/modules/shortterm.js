const fs = require('fs').promises;
const path = require('path');
const { logEvent } = require('../logEvent');
const FILE = path.join(__dirname, '../state/cache.json');

module.exports = {
  async read() {
    try {
      const data = await fs.readFile(FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  },
  async write(data) {
    await fs.writeFile(FILE, JSON.stringify(data, null, 2));
    await logEvent('shortterm');
  },
};
