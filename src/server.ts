import 'dotenv/config';

import { app } from './app.js';
import { performStartup } from './core/startup.js';

const PORT = process.env.PORT || 3000;

/**
 * Starts the ARCANOS HTTP server after startup preflight.
 *
 * Purpose: Ensure startup initialization (including DB init) runs before serving traffic.
 * Inputs/Outputs: Uses process environment; starts Express listener on configured port.
 * Edge cases: Throws if startup preflight fails unexpectedly.
 */
async function startServer(): Promise<void> {
  await performStartup();

  app.listen(PORT, () => {
    console.log(`ARCANOS running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  //audit assumption: startup failures should fail fast; risk: serving partially initialized state; invariant: process exits on unrecoverable startup error; handling: log and terminate.
  console.error('[STARTUP] Fatal startup failure:', error);
  process.exit(1);
});
