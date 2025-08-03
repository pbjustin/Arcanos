import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logEvent } from '../logEvent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '../state/receipt_fail_map.json');

export async function read() {
  try {
    const data = await fs.readFile(FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function flag(email) {
  const map = await read();
  map[email] = (map[email] || 0) + 1;
  await fs.writeFile(FILE, JSON.stringify(map, null, 2));
  await logEvent('receipt_fail_map');
}

export default { read, flag };
