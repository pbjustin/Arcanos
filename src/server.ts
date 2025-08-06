import express from 'express';
import cors from 'cors';
import askRoute from './routes/ask.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON bodies

app.use('/', askRoute);

// Health check endpoint
app.get('/health', (_, res) => {
  res.status(200).send('OK');
});

// Start server with enhanced logging
app.listen(PORT, () => {
  console.log(`🚀 ARCANOS Backend Server started successfully on port ${PORT}`);
  console.log(`📡 Server is ready to accept requests at http://localhost:${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
});