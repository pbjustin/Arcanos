const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Simple health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Optional: Basic route
app.get('/', (req, res) => {
  res.send('Hello from ARCANOS!');
});

// Optional: Handle errors
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Server listening on port ${port}`);
});
