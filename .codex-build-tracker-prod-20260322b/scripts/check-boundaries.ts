import madge from 'madge';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');

async function checkBoundaries() {
  console.log('Checking for circular dependencies and boundary violations...');

  const res = await madge(path.join(projectRoot, 'src'), {
    fileExtensions: ['ts'],
    tsConfig: path.join(projectRoot, 'tsconfig.json'),
    baseDir: projectRoot
  });

  const circular = res.circular();
  if (circular.length > 0) {
    console.error('â Œ Circular dependencies detected:');
    console.error(JSON.stringify(circular, null, 2));
    process.exit(1);
  }

  console.log('âœ… No circular dependencies found.');
}

checkBoundaries().catch(err => {
  console.error('Error during boundary check:', err);
  process.exit(1);
});
