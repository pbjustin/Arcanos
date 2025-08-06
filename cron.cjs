const fs = require('fs');
const path = require('path');
const { log } = require('./utils/logger.cjs');

setInterval(() => {
  const snapshotPath = path.join(__dirname, 'sandbox/memory/last_snapshot.json');
  const data = { timestamp: new Date().toISOString(), heap: process.memoryUsage() };
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, JSON.stringify(data, null, 2));
  log('🧠 Snapshot saved');
}, 300000); // every 5 minutes