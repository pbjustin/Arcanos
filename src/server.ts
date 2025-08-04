/**
 * ARCANOS - Production-Grade AI Backend Server
 * Clean, modular architecture with OpenAI SDK v4 integration
 * Railway deployment ready
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import type { Request, Response, NextFunction } from 'express';
import { openaiClient, createChatCompletion } from './utils/openaiClient.js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} - ${duration}ms`);
  });
  next();
});

// Health check endpoint - Railway compatible
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    service: 'arcanos-backend'
  });
});

// OpenAI chat completion endpoint
app.post('/chat', async (req: Request, res: Response) => {
  try {
    const { message, model = 'gpt-4', temperature = 0.7 } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const completion = await createChatCompletion(
      [{ role: 'user', content: message }],
      { model, temperature }
    );

    const response = completion.choices[0]?.message?.content;
    
    res.json({
      response,
      model,
      usage: completion.usage,
    });
  } catch (error: any) {
    console.error('Chat completion error:', error);
    res.status(500).json({ 
      error: 'Failed to process chat completion',
      message: error.message 
    });
  }
});

// Error handling middleware
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message 
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 ARCANOS Server running on port ${PORT}`);
  console.log(`📋 Available endpoints:`);
  console.log(`   GET  /health - Health check`);
  console.log(`   POST /chat   - OpenAI chat completion`);
  console.log(`🔑 OpenAI SDK v4 initialized and ready`);
});

export default app;