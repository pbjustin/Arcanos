const fs = require('fs').promises;
const path = require('path');
const EVENTS_FILE = path.join(__dirname, 'events.json');

async function logEvent(moduleName) {
  try {
    let events = [];
    try {
      const data = await fs.readFile(EVENTS_FILE, 'utf8');
      events = JSON.parse(data);
    } catch {}
    events.push({ module: moduleName, timestamp: new Date().toISOString() });
    await fs.writeFile(EVENTS_FILE, JSON.stringify(events, null, 2));
  } catch (err) {
    console.error('[MEMORY] Failed to log event:', err.message);
  }
}

module.exports = { logEvent };
