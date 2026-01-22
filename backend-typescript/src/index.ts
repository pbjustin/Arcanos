/**
 * ARCANOS Backend - Main Server
 * Express + PostgreSQL API for ARCANOS daemon
 */

import 'dotenv/config';
import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDatabase } from './database';
import { authenticateJWT, generateToken } from './auth';
import { logger } from './logger';
import { createAuthRouter } from './routes/auth';

// Routes
import askRoute from './routes/ask';
import updateRoute from './routes/update';
import healthRoute from './routes/health';
import auditRoute from './routes/audit';
import arcanosQueryRoute from './routes/arcanosQuery';
import relayRoute from './routes/relay';
import visionRoute from './routes/vision';
import transcribeRoute from './routes/transcribe';

// Create Express app
const app: Express = express();
const parsedPort = Number.parseInt(process.env.PORT || '5000', 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 5000;

const requiredEnv = ['DATABASE_URL', 'JWT_SECRET', 'OPENAI_API_KEY'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  logger.error('Missing required environment variables', { missing: missingEnv });
  process.exit(1);
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
if (!allowedOrigins.length) {
  logger.error('ALLOWED_ORIGINS must be set to an explicit whitelist');
  process.exit(1);
}

// Security middleware
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  void res;
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Routes
const authRouter = createAuthRouter({
  getEnvValue: (key) => process.env[key],
  tokenSigner: generateToken,
  logger
});

app.use('/api/health', healthRoute);
app.use('/healthcheck', healthRoute);
app.use('/api/auth', authRouter);
app.use('/api/ask', authenticateJWT, askRoute);
app.use('/api/update', authenticateJWT, updateRoute);
app.use('/api/audit', authenticateJWT, auditRoute);
app.use('/api/arcanos-query', authenticateJWT, arcanosQueryRoute);
app.use('/api/relay', authenticateJWT, relayRoute);
app.use('/api/vision', authenticateJWT, visionRoute);
app.use('/api/transcribe', authenticateJWT, transcribeRoute);

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  void req;
  res.json({
    name: 'ARCANOS Backend API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/health',
      ask: '/api/ask (POST, requires JWT)',
      update: '/api/update (POST, requires JWT)',
      audit: '/api/audit (GET, requires JWT)',
      arcanosQuery: '/api/arcanos-query (POST, requires JWT)',
      relay: '/api/relay (POST, requires JWT)',
      vision: '/api/vision (POST, requires JWT)',
      transcribe: '/api/transcribe (POST, requires JWT)'
    }
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.path}`
  });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  void next;
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path
  });

  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An error occurred' : err.message
  });
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database
    await initDatabase();
    logger.info('Database initialized');

    // Start listening
    app.listen(PORT, () => {
      logger.info(`🚀 ARCANOS Backend running on port ${PORT}`);
      logger.info(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
startServer();

export default app;
