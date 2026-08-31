#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const INACTIVE_ROLLOUT_HOLD = 'none';
export const ROLLOUT_CONFIRMATION_PREFIX = 'COORDINATED WRITERS DRAINED: ';

const ROLLOUT_HOLD_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function resolveRolloutHold(rawHold) {
  if (typeof rawHold !== 'string' || rawHold.length === 0) {
    throw new Error('COORDINATED_WRITER_ROLLOUT_HOLD_REQUIRED');
  }
  if (rawHold.trim() !== rawHold) {
    throw new Error('COORDINATED_WRITER_ROLLOUT_HOLD_INVALID');
  }
  if (rawHold === INACTIVE_ROLLOUT_HOLD) {
    return null;
  }
  if (!ROLLOUT_HOLD_PATTERN.test(rawHold)) {
    throw new Error('COORDINATED_WRITER_ROLLOUT_HOLD_INVALID');
  }
  return rawHold;
}

export function buildRolloutConfirmation(holdId) {
  const resolvedHold = resolveRolloutHold(holdId);
  if (!resolvedHold) {
    throw new Error('COORDINATED_WRITER_ROLLOUT_HOLD_INACTIVE');
  }
  return `${ROLLOUT_CONFIRMATION_PREFIX}${resolvedHold}`;
}

/**
 * Decide whether the Railway deployment job may start.
 *
 * The hold is repository-owned and fail-closed: a missing, blank, or malformed
 * value is an error. The exact sentinel "none" is the only inactive value.
 * Automatic promotion skips while a hold is active. A manual dispatch may pass
 * only after the operator supplies the hold-specific drained-writers phrase.
 */
export function evaluateCoordinatedRolloutGuard({
  eventName,
  holdId,
  manualConfirmation = '',
}) {
  const resolvedHold = resolveRolloutHold(holdId);

  if (!resolvedHold) {
    return {
      shouldDeploy: true,
      holdActive: false,
      holdId: INACTIVE_ROLLOUT_HOLD,
      reason: 'hold_inactive',
    };
  }

  if (eventName === 'workflow_run') {
    return {
      shouldDeploy: false,
      holdActive: true,
      holdId: resolvedHold,
      reason: 'automatic_promotion_blocked',
    };
  }

  if (eventName !== 'workflow_dispatch') {
    throw new Error('COORDINATED_WRITER_ROLLOUT_EVENT_INVALID');
  }

  if (manualConfirmation !== buildRolloutConfirmation(resolvedHold)) {
    throw new Error('COORDINATED_WRITER_ROLLOUT_CONFIRMATION_REQUIRED');
  }

  return {
    shouldDeploy: true,
    holdActive: true,
    holdId: resolvedHold,
    reason: 'manual_drain_confirmation_accepted',
  };
}

export function renderGitHubOutputs(result) {
  return [
    `should_deploy=${result.shouldDeploy ? 'true' : 'false'}`,
    `hold_active=${result.holdActive ? 'true' : 'false'}`,
    `hold_id=${result.holdId}`,
    `reason=${result.reason}`,
    '',
  ].join('\n');
}

function runFromEnvironment(env = process.env) {
  const outputPath = env.GITHUB_OUTPUT?.trim();
  if (!outputPath) {
    throw new Error('GITHUB_OUTPUT_REQUIRED');
  }

  const result = evaluateCoordinatedRolloutGuard({
    eventName: env.ARCANOS_DEPLOY_EVENT_NAME,
    holdId: env.ARCANOS_COORDINATED_WRITER_ROLLOUT_HOLD,
    manualConfirmation: env.ARCANOS_COORDINATED_WRITER_ROLLOUT_CONFIRMATION ?? '',
  });

  appendFileSync(outputPath, renderGitHubOutputs(result), 'utf8');

  if (result.reason === 'automatic_promotion_blocked') {
    console.log(
      `[railway-rollout-guard] Automatic promotion skipped while coordinated writer hold "${result.holdId}" is active.`,
    );
    return;
  }

  console.log(
    `[railway-rollout-guard] Deployment policy accepted (${result.reason}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runFromEnvironment();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    console.error(`[railway-rollout-guard] ${message}`);
    process.exitCode = 1;
  }
}
