import express from 'express';

const router = express.Router();

// sim module stub - auto-generated fallback
router.get("/", (req, res) => res.send("🧠 /sim route active"));

router.post('/sim', async (req, res) => {
  res.json({
    status: 'stub',
    message: 'sim module stub response',
    data: req.body || {},
    timestamp: new Date().toISOString()
  });
});

router.get('/sim/status', (req, res) => {
  res.json({
    module: 'sim',
    status: 'stub',
    version: '0.0.1',
    endpoints: ['/', '/sim', '/sim/status'],
    note: 'Auto-generated fallback module'
  });
});

export default router;
