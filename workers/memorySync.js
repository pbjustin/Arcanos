const fs = require('fs');
const path = require('path');
const shortterm = require(path.resolve(__dirname, '../memory/modules/shortterm'));

module.exports = async function memorySync() {
  const state = shortterm.read();
  const snapshotPath = path.resolve(__dirname, '../memory/state/cache.snapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(state, null, 2));
  console.log('[MEMORY SYNC] Saved snapshot at', new Date().toISOString());
};
