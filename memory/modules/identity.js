import shortterm from './shortterm.js';
import { logEvent } from '../logEvent.js';

export async function read() {
  const data = await shortterm.read();
  return data.identity || {};
}

export async function write(identity) {
  const data = await shortterm.read();
  data.identity = identity;
  await shortterm.write(data);
  await logEvent('identity');
}

export default { read, write };
