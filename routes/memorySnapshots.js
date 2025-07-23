const express = require('express');
const router = express.Router();
const snapshots = require('../services/memory-snapshots');

router.use(express.json());

// GET /api/memory/snapshots/:key - list versions for key
router.get('/:key', async (req, res) => {
  const { key } = req.params;
  try {
    const versions = await snapshots.getVersions(key);
    res.json({ key, versions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/memory/snapshots/diff/:key?from=x&to=y
router.get('/diff/:key', async (req, res) => {
  const { key } = req.params;
  const from = parseInt(req.query.from, 10);
  const to = parseInt(req.query.to, 10);
  if (isNaN(from) || isNaN(to)) {
    return res.status(400).json({ error: 'from and to query parameters are required' });
  }
  try {
    const result = await snapshots.diffVersions(key, from, to);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/memory/snapshots/rollback { key, version }
router.post('/rollback', async (req, res) => {
  const { key, version } = req.body;
  if (!key || version === undefined) {
    return res.status(400).json({ error: 'key and version are required' });
  }
  try {
    const result = await snapshots.rollback(key, Number(version));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
