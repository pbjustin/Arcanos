const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '../state/context.db');

module.exports = {
  read: () => {
    if (!fs.existsSync(FILE)) return {};
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  },
  write: (data) => fs.writeFileSync(FILE, JSON.stringify(data, null, 2)),
};
