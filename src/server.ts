import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import askRoute from './routes/ask.js';

dotenv.config();

const app = express();
const port = Number(process.env.PORT) || 3000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON bodies

app.use('/', askRoute);

// Health check endpoint
app.get('/health', (_, res) => {
  res.status(200).send('OK');
});

// Start server with enhanced logging
app.listen(port, '0.0.0.0', () => {
  console.log(`ARCANOS core listening on port ${port}`);
});