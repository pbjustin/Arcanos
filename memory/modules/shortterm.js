const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '../state/cache.json');

module.exports = {
  read: () => JSON.parse(fs.readFileSync(FILE, 'utf8')),
  write: (data) => fs.writeFileSync(FILE, JSON.stringify(data, null, 2)),
};
