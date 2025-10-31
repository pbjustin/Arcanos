import { Router, Request, Response } from 'express';
import { getChatGPTUserStatus } from '../middleware/chatgptUser.js';

const router = Router();

router.get('/chatgpt-user-status', (_req: Request, res: Response) => {
  res.json(getChatGPTUserStatus());
});

export default router;
