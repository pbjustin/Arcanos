const express = require('express');
const bodyParser = require('body-parser');
const { log } = require('./utils/logger.cjs');
const { runAI } = require('./aiEngine.cjs');
require('dotenv').config();

const app = express();
app.use(bodyParser.json());

app.get('/', (_, res) => res.send('🚀 ARCANOS Core Active'));

app.post('/ask', async (req, res) => {
  log('📨 POST /ask received');
  const result = await runAI(req.body);
  res.json(result);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => log(`🔥 ARCANOS booted on port ${PORT}`));