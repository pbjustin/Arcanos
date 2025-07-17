import { Router } from 'express';

const router = Router();

// Sample GET endpoint
router.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Arcanos API',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Sample POST endpoint
router.post('/echo', (req, res) => {
  res.json({
    message: 'Echo endpoint',
    data: req.body,
    timestamp: new Date().toISOString()
  });
});

export default router;