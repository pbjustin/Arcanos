import { startServer } from './server.js';

startServer().catch(error => {
  console.error('[❌ ARCANOS CORE] Failed to start server:', error);
  process.exit(1);
});
