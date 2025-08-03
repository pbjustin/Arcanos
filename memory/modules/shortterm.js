import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logEvent } from '../logEvent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE = path.join(__dirname, '../state/cache.json');

export default {
  async read() {
    try {
      const data = await fs.readFile(FILE, 'utf8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  },
  async write(data) {
    await fs.writeFile(FILE, JSON.stringify(data, null, 2));
    await logEvent('shortterm');
  },
};
