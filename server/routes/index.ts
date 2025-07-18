import express from 'express';
const router = express.Router();

router.post('/api/ask', async (req, res) => {
  const { message } = req.body;

  try {
    // TEMP placeholder response
    const response = `Received: ${message}`;
    res.json({ response });
  } catch (error) {
    console.error('Error in /api/ask:', error);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;