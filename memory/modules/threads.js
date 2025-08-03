import shortterm from './shortterm.js';
import { logEvent } from '../logEvent.js';

export async function read() {
  const data = await shortterm.read();
  return data.threads || {};
}

export async function write(threads) {
  const data = await shortterm.read();
  data.threads = threads;
  await shortterm.write(data);
  await logEvent('threads');
}

export async function save(id, thread) {
  const threads = await read();
  threads[id] = thread;
  await write(threads);
  return { saved: true, id };
}

export default { read, write, save };
