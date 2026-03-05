/**
 * Incident Response Kill Switches for Self-Improve
 *
 * - Freeze patching / improvements immediately
 * - Force autonomy level down to 0
 *
 * Default state can be controlled via env vars:
 * - SELF_IMPROVE_FREEZE=true|false
 * - SELF_IMPROVE_AUTONOMY_LEVEL=0..3
 */
import { aiLogger } from "@platform/logging/structuredLogging.js";
import { getConfig } from "@platform/runtime/unifiedConfig.js";

let runtimeFreezeOverride: boolean | null = null;
let runtimeAutonomyOverride: number | null = null;

export function isSelfImproveFrozen(): boolean {
  const cfg = getConfig();
  return runtimeFreezeOverride ?? cfg.selfImproveFrozen;
}

export function getEffectiveAutonomyLevel(): number {
  const cfg = getConfig();
  const lvl = runtimeAutonomyOverride ?? cfg.selfImproveAutonomyLevel;
  return Math.max(0, Math.min(3, lvl));
}

export function freezeSelfImprove(reason: string): void {
  runtimeFreezeOverride = true;
  runtimeAutonomyOverride = 0;
  aiLogger.error("Self-improve frozen (kill switch)", { module: "killSwitch", reason });
}

export function unfreezeSelfImprove(reason: string): void {
  runtimeFreezeOverride = false;
  aiLogger.warn("Self-improve unfrozen", { module: "killSwitch", reason });
}

export function setAutonomyLevel(level: number, reason: string): void {
  runtimeAutonomyOverride = Math.max(0, Math.min(3, level));
  aiLogger.warn("Self-improve autonomy override set", { module: "killSwitch", level: runtimeAutonomyOverride, reason });
}

export function getKillSwitchStatus() {
  return {
    frozen: isSelfImproveFrozen(),
    autonomyLevel: getEffectiveAutonomyLevel(),
    overrides: {
      freeze: runtimeFreezeOverride,
      autonomy: runtimeAutonomyOverride
    }
  };
}
