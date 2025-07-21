// index.js
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ARCANOS-compatible endpoints

app.post('/ask', (req, res) => {
  const { query, mode = 'logic' } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query field' });

  res.json({ response: `Query received: "${query}" in mode: "${mode}"` });
});

app.post('/simulate', (req, res) => {
  const { scenario } = req.body;
  if (!scenario) return res.status(400).json({ error: 'Missing scenario field' });

  res.json({ result: `Simulating scenario: "${scenario}"` });
});

app.post('/build', (req, res) => {
  const { spec } = req.body;
  if (!spec) return res.status(400).json({ error: 'Missing spec field' });

  res.json({ result: `Built logic block for spec: "${spec}"` });
});

app.get('/status', (req, res) => {
  res.json({ status: 'ARCANOS backend is operational' });
});

// Root endpoint
app.get('/', (req, res) => {
  res.send('Welcome to your ARCANOS backend API.');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});