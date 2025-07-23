const express = require('express');
const router = express.Router();

router.get('/workers', async (req, res) => {
  try {
    const workers = [
      { name: 'AuditWorker', status: 'running', lastCheck: new Date().toISOString() },
      { name: 'MemorySync', status: 'idle', lastRun: '2025-07-22T02:00:00Z' }
    ];
    res.json(workers);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Worker route failure',
      details: error.message
    });
  }
});

module.exports = router;
