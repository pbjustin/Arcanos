import fs from 'fs';
import path from 'path';

const memoryPath = path.resolve('./dist/services/memory');
const fallbackPath = path.resolve('./fallback/memory');

if (!fs.existsSync(memoryPath)) {
  console.warn('Memory module not found, applying fallback...');

  // Create fallback memory service directory and placeholder
  fs.mkdirSync(memoryPath, { recursive: true });
  fs.copyFileSync(`${fallbackPath}/memory-core.js`, `${memoryPath}/memory-core.js`);

  console.log('✅ Fallback memory module deployed.');
} else {
  console.log('🧠 Memory module verified and intact.');
}
