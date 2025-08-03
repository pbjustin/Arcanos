import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EVENTS_FILE = path.join(__dirname, 'events.json');

export async function logEvent(moduleName) {
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
