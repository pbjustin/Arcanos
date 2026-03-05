/**
 * Autonomy tiers for self-improve loop.
 *
 * Level 0: observe only
 * Level 1: propose only
 * Level 2: auto-apply soft changes in non-prod
 * Level 3: limited auto in prod (still must pass gates)
 */
import { getEffectiveAutonomyLevel } from "@services/incidentResponse/killSwitch.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";

export function getAutonomyLevel(): number {
  const lvl = getEffectiveAutonomyLevel();
  return Math.max(0, Math.min(3, lvl));
}

export function canAutoApplySoftChanges(): boolean {
  const cfg = getConfig();
  const lvl = getAutonomyLevel();
  if (lvl < 2) return false;
  if (cfg.selfImproveEnvironment === 'production') return lvl >= 3;
  return true;
}

export function canProposePatches(): boolean {
  return getAutonomyLevel() >= 1;
}
