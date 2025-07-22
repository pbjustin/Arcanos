const express = require('express');
const router = express.Router();
const memory = require('../services/memory');

router.get('/test-memory', async (req, res) => {
  try {
    await memory.set('test_key', '✅ Memory is working!');
    const result = await memory.get('test_key');
    res.json({ status: 'success', test_key: result });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Memory test failed',
      error: error.message
    });
  }
});

module.exports = router;
