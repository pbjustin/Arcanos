import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

// ✅ Secure token (store in environment variable)
const AUTH_TOKEN = process.env.ARCANOS_AUTH_TOKEN;

// ✅ Simple authentication middleware
function authenticate(req, res, next) {
  const token = req.headers['x-arcanos-token'];
  if (!token || token !== AUTH_TOKEN) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

// ✅ Fallback handler with retry logic
async function runWithRetry(taskFn, retries = 3) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await taskFn();
    } catch (err) {
      attempt++;
      if (attempt >= retries) throw err;
    }
  }
}

// ✅ Diagnostic endpoint
app.post('/api/arcanos/diagnostics', authenticate, async (req, res) => {
  const { command, params } = req.body;
  try {
    const result = await runWithRetry(async () => {
      // Your backend AI's diagnostic function here
      return await global.backendAI.runCommand(command, params);
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ Start the bridge server

// Use Railway's assigned port or fallback to 4000
const PORT = process.env.PORT || 4000;

// Bind to 0.0.0.0 so it’s reachable externally
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Arcanos backend bridge running on port ${PORT} and bound to 0.0.0.0`);
});
