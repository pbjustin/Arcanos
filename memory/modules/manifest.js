import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logEvent } from '../logEvent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '../state/manifest.json');

export async function read() {
  try {
    const data = await fs.readFile(FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function add(entry) {
  const manifest = await read();
  manifest.push({ ...entry, timestamp: new Date().toISOString() });
  await fs.writeFile(FILE, JSON.stringify(manifest, null, 2));
  await logEvent('manifest');
}

export default { read, add };
