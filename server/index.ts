import express from 'express';
import askRoutes from './routes/index';

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.use('/', askRoutes);

const PORT = process.env.PORT || 5000;

// Start server - ensure unconditional startup
console.log(`🚀 Starting server on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode...`);

const server = app.listen(PORT, () => {
  console.log(`✅ Server successfully running on port ${PORT}`);
  console.log(`📊 Process PID: ${process.pid}`);
});

// Handle server startup errors
server.on('error', (error: any) => {
  console.error('❌ Server failed to start:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
  }
  // In production, exit on startup failure
  if (process.env.NODE_ENV === 'production') {
    console.error('💀 Exiting due to server startup failure in production');
    process.exit(1);
  }
});

// Handle unhandled promise rejections to prevent unexpected exits
process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
  // Keep the process alive - log but don't exit
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught Exception thrown:', error);
  // In production, try to keep the server running unless it's a critical error
  if (process.env.NODE_ENV === 'production') {
    console.error('⚠️ Keeping server alive despite uncaught exception');
  } else {
    console.error('💀 Exiting in development mode due to uncaught exception');
    process.exit(1);
  }
});

// Graceful shutdown
const gracefulShutdown = (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Gracefully shutting down...`);
  server.close((err) => {
    if (err) {
      console.error('❌ Error during server shutdown:', err);
      process.exit(1);
    }
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));