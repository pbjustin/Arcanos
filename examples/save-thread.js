const memory = require('../memory/kernel');

async function main() {
  const result = await memory.dispatch('saveThread', {
    id: 'thread-test-save',
    tags: ['test', 'save'],
    state: {
      goals: ['Test memory write'],
      context: 'This is a test save operation from the goalWatcher console.',
      log: [{ role: 'user', content: 'Did this save?' }]
    }
  });
  console.log(result);
}

main();
