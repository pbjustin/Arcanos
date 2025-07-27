const fs = require('fs').promises;
const path = require('path');
const { logEvent } = require('../logEvent');
const FILE = path.join(__dirname, '../state/email_diagnostics.json');

module.exports = {
  async read() {
    try {
      const data = await fs.readFile(FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  },
  async add(entry) {
    const data = await this.read();
    data[entry.diagnosticId] = entry;
    await fs.writeFile(FILE, JSON.stringify(data, null, 2));
    await logEvent('email_diagnostics');
  }
};
