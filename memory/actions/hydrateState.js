import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FILE = path.join(__dirname, '../state/cache.json');

export default function hydrateState(defaultState = {}) {
  if (!fs.existsSync(FILE)) {
    fs.writeFileSync(FILE, JSON.stringify(defaultState, null, 2));
    return { hydrated: true, state: defaultState };
  }
  const current = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return { hydrated: true, state: current };
}
