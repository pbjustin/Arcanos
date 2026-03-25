import 'dotenv/config';

import { app } from './app.js';
import { performStartup } from './core/startup.js';
import { startSelfHealingLoop } from '@services/selfImprove/selfHealingLoop.js';

const PORT = process.env.PORT || 3000;

interface StartupDeploymentSummary {
  serviceName: string;
  deploymentId: string;
  gitCommit: string;
  gitBranch: string;
}

/**
 * Resolve deployment metadata for startup logging.
 *
 * Purpose:
 * - Emit enough Railway context to confirm which artifact is serving traffic.
 *
 * Inputs/outputs:
 * - Input: Railway and git-related environment variables.
 * - Output: normalized deployment summary strings for startup logs.
 *
 * Edge case behavior:
 * - Missing metadata degrades to `unknown` so startup logging still succeeds.
 */
function resolveStartupDeploymentSummary(): StartupDeploymentSummary {
  const serviceName = process.env.RAILWAY_SERVICE_NAME?.trim();
  const deploymentId = process.env.RAILWAY_DEPLOYMENT_ID?.trim();
  const gitCommit = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
  const gitBranch = process.env.RAILWAY_GIT_BRANCH?.trim();

  //audit Assumption: Railway deployment metadata may be absent in local development or manual runtime contexts; failure risk: startup logs throw or hide service identity; expected invariant: startup logging always emits a stable summary; handling strategy: normalize missing metadata to `unknown`.
  return {
    serviceName: serviceName || 'unknown',
    deploymentId: deploymentId || 'unknown',
    gitCommit: gitCommit || 'unknown',
    gitBranch: gitBranch || 'unknown'
  };
}

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
    const selfHealLoopStatus = startSelfHealingLoop();
    const startupDeploymentSummary = resolveStartupDeploymentSummary();
    console.log(
      `ARCANOS running on port ${PORT} | service=${startupDeploymentSummary.serviceName} | deployment=${startupDeploymentSummary.deploymentId} | git=${startupDeploymentSummary.gitCommit} | branch=${startupDeploymentSummary.gitBranch} | workerHelperRoutes=enabled | askWorkerTools=enabled | selfHealLoop=${selfHealLoopStatus.loopRunning ? 'enabled' : 'disabled'} | selfHealIntervalMs=${selfHealLoopStatus.intervalMs}`
    );
  });
}

startServer().catch((error) => {
  //audit assumption: startup failures should fail fast; risk: serving partially initialized state; invariant: process exits on unrecoverable startup error; handling: log and terminate.
  console.error('[STARTUP] Fatal startup failure:', error);
  process.exit(1);
});
