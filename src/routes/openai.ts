import express from 'express';
import { handlePrompt } from '../controllers/openaiController.js';

const router = express.Router();

router.post('/prompt', handlePrompt);

export default router;
