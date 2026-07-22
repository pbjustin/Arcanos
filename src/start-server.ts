import { startServer } from './server.js';

startServer().catch((error) => {
  //audit assumption: startup failures should fail fast; risk: serving partially initialized state; invariant: process exits on unrecoverable startup error; handling: log and terminate.
  console.error('[STARTUP] Fatal startup failure:', error);
  process.exit(1);
});
