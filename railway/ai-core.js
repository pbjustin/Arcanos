import { spawn } from 'child_process';
import { existsSync } from 'fs';

console.log('AI core starting');

if (!existsSync('./dist/server.js')) {
  console.error('dist/server.js not found. Please build the project first.');
  process.exit(1);
}

const server = spawn('node', ['dist/server.js'], {
  stdio: 'inherit',
});

server.on('close', (code) => {
  console.log(`AI core exited with code ${code}`);
  process.exit(code ?? 0);
});
