import { write, reset, read } from '../workers/memory.js';

write({ session: 'test-session-123' });
reset();

const state = read();
if (state.session !== null) {
  throw new Error('Memory reset failed!');
}

console.log('✅ Memory reset test passed.');
