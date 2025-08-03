import threads from '../modules/threads.js';

export default async function saveThread({ id, tags = [], state = {} }) {
  if (!id) {
    return { error: 'id is required' };
  }
  const thread = { id, tags, state, timestamp: new Date().toISOString() };
  return threads.save(id, thread);
}
