import fs from 'fs';
import path from 'path';
import { ensureLogDirectory, getAuditShadowPath, getLogPath } from '../utils/logPath.js';
import { checkMemoryIntegrity } from './memoryAware.js';

const DISABLE_FLAG_FILE = path.join(getLogPath(), 'shadow_disabled');

let shadowEnabled = (process.env.ARC_SHADOW_MODE || 'enabled') !== 'disabled' && !fs.existsSync(DISABLE_FLAG_FILE);

export function isShadowModeEnabled(): boolean {
  return shadowEnabled && !fs.existsSync(DISABLE_FLAG_FILE);
}

export function disableShadowMode(reason: string = 'unknown'): void {
  shadowEnabled = false;
  ensureLogDirectory();
  try {
    fs.writeFileSync(DISABLE_FLAG_FILE, reason);
    fs.appendFileSync(getAuditShadowPath(), `${new Date().toISOString()} | SHADOW_DISABLED | ${reason}\n`);
  } catch {
    // ignore file system errors
  }
  console.warn(`⚠️ [SHADOW] Disabled: ${reason}`);
}

export function enableShadowMode(): void {
  ensureLogDirectory();
  shadowEnabled = true;
  try {
    if (fs.existsSync(DISABLE_FLAG_FILE)) fs.unlinkSync(DISABLE_FLAG_FILE);
    fs.appendFileSync(getAuditShadowPath(), `${new Date().toISOString()} | SHADOW_ENABLED\n`);
  } catch {
    // ignore errors
  }
}

export function ensureShadowReady(): boolean {
  if (!isShadowModeEnabled()) return false;
  const healthy = checkMemoryIntegrity();
  if (!healthy) {
    disableShadowMode('memory_fault');
    return false;
  }
  return true;
}
