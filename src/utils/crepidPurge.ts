/**
 * CREPID Code Purge Utility
 * 
 * Handles legacy code cleanup with audit trail generation.
 * Supports soft (move to deprecated/) and hard (delete) modes.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface DeprecationAudit {
  modulePath: string;
  importWeight: number;
  lastCommit: string;
  lastCommitDate: string;
  removalRisk: 'low' | 'medium' | 'high';
  dependencies: string[];
  deprecatedAt: string;
  reason: string;
}

/**
 * Get CREPID purge mode from environment
 */
export function getPurgeMode(): 'off' | 'soft' | 'hard' {
  const mode = process.env.CREPID_PURGE?.toLowerCase() || 'off';
  if (mode !== 'off' && mode !== 'soft' && mode !== 'hard') {
    console.warn(`[CREPID] Invalid CREPID_PURGE mode: ${mode}. Using 'off'`);
    return 'off';
  }
  return mode as 'off' | 'soft' | 'hard';
}

/**
 * Get last commit info for a file
 */
function getLastCommit(filePath: string): { hash: string; date: string } {
  try {
    const hash = execSync(`git log -1 --format="%H" -- ${filePath}`, { encoding: 'utf-8' }).trim();
    const date = execSync(`git log -1 --format="%ai" -- ${filePath}`, { encoding: 'utf-8' }).trim();
    return { hash, date };
  } catch {
    return { hash: 'unknown', date: new Date().toISOString() };
  }
}

/**
 * Find files that import the given module
 */
function findImporters(modulePath: string, searchPath: string = 'src'): string[] {
  const importers: string[] = [];
  const moduleName = path.basename(modulePath, path.extname(modulePath));
  
  try {
    // Use grep to find files that import this module
    const grepCommand = `grep -rl "from.*${moduleName}" ${searchPath} || true`;
    const result = execSync(grepCommand, { encoding: 'utf-8' });
    
    if (result) {
      importers.push(...result.split('\n').filter(line => line.trim() && line !== modulePath));
    }
  } catch {
    // Grep failed or no matches - return empty array
  }
  
  return importers;
}

/**
 * Calculate import weight (number of files importing this module)
 */
function calculateImportWeight(modulePath: string): number {
  const importers = findImporters(modulePath);
  return importers.length;
}

/**
 * Assess removal risk based on import weight and last commit age
 */
function assessRemovalRisk(importWeight: number, lastCommitDate: string): 'low' | 'medium' | 'high' {
  const monthsSinceLastCommit = (Date.now() - new Date(lastCommitDate).getTime()) / (1000 * 60 * 60 * 24 * 30);
  
  if (importWeight === 0 && monthsSinceLastCommit > 6) {
    return 'low';
  } else if (importWeight < 3 && monthsSinceLastCommit > 3) {
    return 'low';
  } else if (importWeight < 10 || monthsSinceLastCommit > 1) {
    return 'medium';
  }
  
  return 'high';
}

/**
 * Generate audit trail for deprecated module
 */
export function generateAuditTrail(modulePath: string, reason: string): DeprecationAudit {
  const { hash, date } = getLastCommit(modulePath);
  const importWeight = calculateImportWeight(modulePath);
  const dependencies = findImporters(modulePath);
  const removalRisk = assessRemovalRisk(importWeight, date);
  
  return {
    modulePath,
    importWeight,
    lastCommit: hash,
    lastCommitDate: date,
    removalRisk,
    dependencies,
    deprecatedAt: new Date().toISOString(),
    reason
  };
}

/**
 * Save audit trail to file
 */
export function saveAuditTrail(audit: DeprecationAudit): void {
  const auditDir = path.join(process.cwd(), 'deprecated', 'audit');
  const fileName = `${path.basename(audit.modulePath, path.extname(audit.modulePath))}_${Date.now()}.json`;
  const auditPath = path.join(auditDir, fileName);
  
  fs.mkdirSync(auditDir, { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  
  console.log(`[CREPID] Audit trail saved: ${auditPath}`);
}

/**
 * Move file to deprecated directory (soft purge)
 */
export function softPurge(filePath: string, reason: string): void {
  const mode = getPurgeMode();
  
  if (mode === 'off') {
    console.log(`[CREPID] Purge mode is OFF. File not moved: ${filePath}`);
    return;
  }
  
  if (mode !== 'soft') {
    console.log(`[CREPID] Purge mode is ${mode}. Use 'soft' for moving to deprecated/`);
    return;
  }
  
  // Generate audit trail
  const audit = generateAuditTrail(filePath, reason);
  saveAuditTrail(audit);
  
  // Determine target directory based on file location
  const relativePath = path.relative(process.cwd(), filePath);
  const targetSubdir = relativePath.startsWith('src/') ? 'modules' : 
                       relativePath.startsWith('scripts/') ? 'scripts' : 
                       'utils';
  
  const deprecatedDir = path.join(process.cwd(), 'deprecated', targetSubdir);
  const targetPath = path.join(deprecatedDir, path.basename(filePath));
  
  // Move file
  fs.mkdirSync(deprecatedDir, { recursive: true });
  fs.renameSync(filePath, targetPath);
  
  console.log(`[CREPID] File moved to deprecated: ${filePath} -> ${targetPath}`);
  console.log(`[CREPID] Removal risk: ${audit.removalRisk}`);
  console.log(`[CREPID] Import weight: ${audit.importWeight}`);
  
  if (audit.dependencies.length > 0) {
    console.warn(`[CREPID] WARNING: ${audit.dependencies.length} files depend on this module:`);
    audit.dependencies.forEach(dep => console.warn(`  - ${dep}`));
  }
}

/**
 * Permanently delete file (hard purge)
 */
export function hardPurge(filePath: string, reason: string): void {
  const mode = getPurgeMode();
  
  if (mode !== 'hard') {
    console.log(`[CREPID] Hard purge requires CREPID_PURGE=hard. Current mode: ${mode}`);
    return;
  }
  
  // Only allow hard purge in staging or test environments
  const env = process.env.NODE_ENV || 'development';
  if (env === 'production') {
    console.error(`[CREPID] Hard purge is not allowed in production. Use soft purge instead.`);
    return;
  }
  
  // Generate audit trail before deletion
  const audit = generateAuditTrail(filePath, reason);
  saveAuditTrail(audit);
  
  if (audit.removalRisk === 'high') {
    console.error(`[CREPID] Cannot hard purge high-risk file: ${filePath}`);
    console.error(`[CREPID] Import weight: ${audit.importWeight}, Dependencies: ${audit.dependencies.length}`);
    return;
  }
  
  // Delete file
  fs.unlinkSync(filePath);
  
  console.log(`[CREPID] File permanently deleted: ${filePath}`);
  console.log(`[CREPID] Audit trail preserved for recovery`);
}

/**
 * List all deprecated files
 */
export function listDeprecated(): void {
  const deprecatedDir = path.join(process.cwd(), 'deprecated');
  
  if (!fs.existsSync(deprecatedDir)) {
    console.log('[CREPID] No deprecated files found');
    return;
  }
  
  console.log('\n=== DEPRECATED FILES ===');
  
  ['modules', 'scripts', 'utils'].forEach(subdir => {
    const subdirPath = path.join(deprecatedDir, subdir);
    if (fs.existsSync(subdirPath)) {
      const files = fs.readdirSync(subdirPath);
      if (files.length > 0) {
        console.log(`\n${subdir}:`);
        files.forEach(file => console.log(`  - ${file}`));
      }
    }
  });
  
  console.log('\n========================\n');
}
