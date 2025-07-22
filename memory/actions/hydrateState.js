const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '../state/cache.json');

module.exports = function hydrateState(defaultState = {}) {
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(defaultState, null, 2));
    return { hydrated: true, state: defaultState };
  }
  const current = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return { hydrated: true, state: current };
};
