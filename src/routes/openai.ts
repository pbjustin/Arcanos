import express from 'express';
import { handlePrompt, getOpenAIStatus } from '../controllers/openaiController.js';

const router = express.Router();

router.get('/status', getOpenAIStatus);
router.post('/prompt', handlePrompt);

export default router;
