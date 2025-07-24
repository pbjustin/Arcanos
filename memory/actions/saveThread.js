const threads = require('../modules/threads');

module.exports = async function saveThread({ id, tags = [], state = {} }) {
  if (!id) {
    return { error: 'id is required' };
  }
  const thread = { id, tags, state, timestamp: new Date().toISOString() };
  return threads.save(id, thread);
};
