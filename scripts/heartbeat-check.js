const fs = require('fs');
const path = require('path');
const { HRCOverlay } = require('../src/modules/overlay');
const logDir = path.resolve(__dirname, '../logs');
const logFile = path.join(logDir, 'system-health.log');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

function log(message) {
  fs.appendFileSync(logFile, message + '\n');
}

async function run() {
  const overlays = [new HRCOverlay()];
  for (const overlay of overlays) {
    try {
      const result = await overlay.evaluate('heartbeat check', 'system');
      const clarity = Math.round(result.metrics.fidelity * 100);
      const logic = Math.round(result.metrics.resilience * 100);
      log(`${new Date().toISOString()} overlay OK clarity=${clarity} logic=${logic}`);
    } catch (err) {
      log(`${new Date().toISOString()} overlay error ${err.message}`);
    }
  }
}

run().catch(err => {
  log(`${new Date().toISOString()} heartbeat failure ${err.message}`);
});
