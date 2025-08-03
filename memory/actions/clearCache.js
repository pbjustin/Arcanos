import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE = path.join(__dirname, '../state/cache.json');

export default function clearCache() {
  fs.writeFileSync(FILE, JSON.stringify({}));
  return { cleared: true };
}
