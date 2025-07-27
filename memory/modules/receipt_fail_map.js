const fs = require('fs').promises;
const path = require('path');
const { logEvent } = require('../logEvent');
const FILE = path.join(__dirname, '../state/receipt_fail_map.json');

module.exports = {
  async read() {
    try {
      const data = await fs.readFile(FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  },
  async flag(email) {
    const map = await this.read();
    map[email] = (map[email] || 0) + 1;
    await fs.writeFile(FILE, JSON.stringify(map, null, 2));
    await logEvent('receipt_fail_map');
  }
};
