const path = require('path');
const memory = require(path.resolve(__dirname, '../../services/memory'));

module.exports = async function memoryAudit() {
  const threadId = 'thread-test-save-audit';
  const entry = {
    context: 'Memory audit context check',
    log: [
      {
        role: 'user',
        content: 'Sample message for audit verification'
      }
    ],
    timestamp: new Date().toISOString()
  };

  try {
    await memory.set(threadId, entry);
    const result = await memory.get(threadId);
    console.log('[MEMORY AUDIT] Recalled:', result);
  } catch (err) {
    console.error('[MEMORY AUDIT] Error:', err.message);
  }
};
