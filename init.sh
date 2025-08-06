#!/bin/sh

# init.sh — ARCANOS empty-service bootstrap script

echo "🚀 Installing dependencies..."
npm install express body-parser openai dotenv concurrently

echo "📦 Creating folders..."
mkdir -p sandbox/memory utils logs modules

echo "🧠 Writing logger module..."
cat << 'EOF' > utils/logger.js
const fs = require('fs');
const path = require('path');
const logFile = path.join(__dirname, '../logs/arc.log');
function log(msg) {
  const time = new Date().toISOString();
  const line = `[${time}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}
module.exports = { log };
EOF

echo "🧠 Writing AI Engine..."
cat << 'EOF' > modules/aiEngine.js
require('dotenv').config();
const OpenAI = require('openai');
const { log } = require('../utils/logger');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function runAI(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: prompt.messages || [{ role: 'user', content: prompt.input || 'Hello' }],
      temperature: 0.7
    });
    log('✅ AI completion returned.');
    return completion;
  } catch (e) {
    log('❌ AI error: ' + e.message);
    return { error: e.message };
  }
}
module.exports = { runAI };
EOF

echo "🧠 Writing cron job..."
cat << 'EOF' > modules/cron.js
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logger');
function snapshot() {
  const file = path.resolve('sandbox/memory/last_snapshot.json');
  const data = { timestamp: new Date().toISOString(), heap: process.memoryUsage() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  log('📸 Snapshot written.');
}
setInterval(snapshot, 300000);
snapshot();
EOF

echo "🧠 Writing server..."
cat << 'EOF' > server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { runAI } = require('./modules/aiEngine');
const { log } = require('./utils/logger');
require('./modules/cron'); // activate cron

const app = express();
app.use(bodyParser.json());

app.get('/', (_, res) => res.send('ARCANOS core active'));

app.post('/ask', async (req, res) => {
  log('🛰️ /ask hit');
  const result = await runAI(req.body);
  res.json(result);
});

['sim', 'guide', 'audit', 'track', 'write'].forEach(route => {
  app.post(`/${route}`, (req, res) => {
    log(`🛰️ /${route} hit — module not wired yet`);
    res.json({ message: `${route} acknowledged (inactive)` });
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => log(`🔥 ARCANOS online @ ${PORT}`));
EOF

echo "🧠 Updating package.json..."
npx json -I -f package.json -e '
  this.scripts = {
    "main": "node server.js",
    "start": "node server.js",
    "dev": "nodemon server.js"
  }
'

echo "✅ DONE. Run: bash init.sh && npm start"