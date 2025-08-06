import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON bodies

// Health check endpoint
app.get('/health', (_, res) => {
  res.status(200).send('OK');
});

// POST /ask endpoint
app.post('/ask', (req, res) => {
  const { prompt } = req.body;
  
  // Validate that prompt is provided
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({
      error: 'Missing or invalid prompt in request body'
    });
  }
  
  // Return mock AI response in the specified format
  const response = {
    result: `Echoed: ${prompt}`, // Echo the prompt as placeholder AI output
    module: 'mock-AI',
    meta: {
      timestamp: new Date().toISOString() // Current UTC timestamp
    }
  };
  
  res.json(response);
});

// Start server with enhanced logging
app.listen(PORT, () => {
  console.log(`🚀 ARCANOS Backend Server started successfully on port ${PORT}`);
  console.log(`📡 Server is ready to accept requests at http://localhost:${PORT}`);
  console.log(`🔧 Environment: ${process.env.NODE_ENV || 'development'}`);
});