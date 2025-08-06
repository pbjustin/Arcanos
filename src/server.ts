import express, { type Request, type Response, type NextFunction } from 'express';
import type { Router } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
let bootstrapFn: () => Promise<void>;
let getMemoryHealth: () => Record<string, unknown>;
try {
  ({ bootstrap: bootstrapFn, getMemoryHealth } = await import('./bootstrap.js'));
} catch {
  ({ bootstrap: bootstrapFn, getMemoryHealth } = await import('./bootstrap.ts'));
}

// Load environment variables
dotenv.config();

// Comprehensive bootstrap routine
await bootstrapFn();

const app = express();
const port = Number(process.env.PORT) || 3000;

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'development' ? true : process.env.ALLOWED_ORIGINS?.split(','),
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, _: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
  });

// Load API routes with fallback if unavailable
let askRoute: Router;
try {
  askRoute = (await import('./routes/ask.js')).default;
} catch {
  console.warn('ask route not found – using placeholder');
  askRoute = express.Router();
  askRoute.post('/ask', (_req: Request, res: Response) => {
    res.status(200).json({ success: true, message: 'Ask route placeholder' });
  });
}

app.use('/', askRoute);

// Health check endpoint
app.get('/health', (_: Request, res: Response) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'ARCANOS',
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Memory health check endpoint
app.get('/memory-health', (_: Request, res: Response) => {
  res.status(200).json({
    status: 'OK',
    ...getMemoryHealth(),
  });
});

// Root endpoint
app.get('/', (_: Request, res: Response) => {
  res.json({
    message: 'Welcome to ARCANOS AI Service',
    endpoints: {
      health: '/health',
      ask: '/ask (POST)'
    }
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, _: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use((_: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
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

// Start server with enhanced logging
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`ARCANOS core listening on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Process ID: ${process.pid}`);
});

// Handle server errors
server.on('error', (err: Error) => {
  console.error('Server error:', err);
  process.exit(1);
});

export default app;
