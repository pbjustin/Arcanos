const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '../state/cache.json');

module.exports = function clearCache() {
  fs.writeFileSync(FILE, JSON.stringify({}));
  return { cleared: true };
};
