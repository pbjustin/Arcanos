const fs = require('fs').promises;
const path = require('path');
const { logEvent } = require('../logEvent');
const FILE = path.join(__dirname, '../state/manifest.json');

module.exports = {
  async read() {
    try {
      const data = await fs.readFile(FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  },
  async add(entry) {
    const manifest = await this.read();
    manifest.push({ ...entry, timestamp: new Date().toISOString() });
    await fs.writeFile(FILE, JSON.stringify(manifest, null, 2));
    await logEvent('manifest');
  }
};
