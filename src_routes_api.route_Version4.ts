import express from 'express';
import testOpenAIRouter from '../test-openai.js';

const router = express.Router();

router.use('/ask', testOpenAIRouter);

export default router;