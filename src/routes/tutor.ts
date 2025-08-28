import express, { Request, Response } from 'express';
import ArcanosTutor from '../modules/arcanos-tutor.js';

const router = express.Router();

router.post('/tutor', async (req: Request, res: Response) => {
  const { module, action, payload } = req.body;

  if (module !== 'ARCANOS:TUTOR') {
    return res.status(404).json({ error: 'Module not found' });
  }

  try {
    const result = await (ArcanosTutor as any).actions[action](payload);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

