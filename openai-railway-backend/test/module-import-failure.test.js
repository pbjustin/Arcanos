const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const modulesDir = path.join(__dirname, '..', 'modules');

 test('loadModules handles module import failure', async () => {
  // create a module that throws on require
  const badModulePath = path.join(modulesDir, 'badModule.js');
  fs.writeFileSync(badModulePath, 'throw new Error("bad module");');

  process.env.NODE_ENV = 'test';
  let warned = false;
  const originalWarn = console.warn;
  console.warn = (msg) => { if (msg.includes('Failed to load module')) warned = true; };

  delete require.cache[require.resolve('../server')];
  require('../server');

  console.warn = originalWarn;
  fs.unlinkSync(badModulePath);

  assert.ok(warned, 'expected warning for failed module load');
 });
