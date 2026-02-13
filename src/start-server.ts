import { validateRequiredEnv } from "@platform/runtime/env.js";
import { startServer } from './server.js';

// Fail fast if required env vars are missing
validateRequiredEnv();

startServer().catch(error => {
  console.error('[❌ ARCANOS CORE] Failed to start server:', error);
  process.exit(1);
});
