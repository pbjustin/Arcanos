import express from 'express';

import { askHandler } from './routes/ask.js';
import { queryFinetuneHandler } from './routes/queryFinetune.js';

export const app = express();

app.use(express.json());

app.post('/ask', askHandler);
app.post('/query-finetune', queryFinetuneHandler);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

export function createApp() {
  return app;
}