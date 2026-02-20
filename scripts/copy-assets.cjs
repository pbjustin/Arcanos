const fs = require('fs');
const path = require('path');

const src = path.join('config', 'prompts.json');
const dests = ['dist/config', 'dist/platform/runtime'];

if (!fs.existsSync(src)) {
  console.error(`Source file not found: ${path.resolve(src)}`);
  process.exit(1);
}

dests.forEach(d => {
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(src, path.join(d, 'prompts.json'));
});

console.log('Copied prompts.json to dist/');
