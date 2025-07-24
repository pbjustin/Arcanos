const express = require('express');
const cors = require('cors');
const path = require('path');

const router = express.Router();
router.use(cors());
router.use(express.json());

router.post('/', async (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ ok: false, error: 'type required' });
  
  try {
    if (type === 'background-tasks') {
      // Run all background tasks on demand
      const { runWorkers } = require('../../workers/index.js');
      runWorkers();
      res.json({ ok: true, result: 'Background tasks executed' });
    } else {
      // Try to run specific worker
      const worker = require(path.resolve(__dirname, `../../workers/${type}.js`));
      const result = await worker(payload);
      res.json({ ok: true, result });
    }
  } catch (err) {
    console.error('Worker dispatch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET endpoint to list available workers
router.get('/', (req, res) => {
  res.json({
    available_workers: [
      'background-tasks',
      'memorySync', 
      'goalWatcher',
      'clearTemp'
    ],
    description: 'POST with {"type": "worker-name", "payload": {}} to dispatch'
  });
});

module.exports = router;
