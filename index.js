const express = require('express');
const app = express();
const statusRoute = require('./routes/status');

app.use('/status', statusRoute);

// Global error catcher
const { logError } = require('./utils/logger');
app.use((err, req, res, next) => {
  logError(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));