import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logEvent } from '../logEvent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, '../state/email_diagnostics.json');

export async function read() {
  try {
    const data = await fs.readFile(FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

export async function add(entry) {
  const data = await read();
  data[entry.diagnosticId] = entry;
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
  await logEvent('email_diagnostics');
}

export default { read, add };
