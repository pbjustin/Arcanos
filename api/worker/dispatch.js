const express = require('express');
const cors = require('cors');

const router = express.Router();
router.use(cors());
router.use(express.json());

router.post('/', async (req, res) => {
  const { type, payload } = req.body || {};
  if (!type) return res.status(400).json({ ok: false, error: 'type required' });
  try {
    const worker = require(`../../workers/${type}.js`);
    const result = await worker(payload);
    res.json({ ok: true, result });
  } catch (err) {
    console.error('Worker dispatch error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
