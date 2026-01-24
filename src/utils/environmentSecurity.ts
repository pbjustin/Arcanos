import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { logger } from './structuredLogging.js';
import { KNOWN_ENVIRONMENT_FINGERPRINTS, EnvironmentFingerprintRecord } from '../config/environmentFingerprints.js';
import { setAuditSafeMode } from '../persistenceManagerHierarchy.js';
import { RUNTIME_PROBE_SUMMARY_SCRIPT } from '../config/runtimeProbeScripts.js';

export interface EnvironmentFingerprint {
  platform: NodeJS.Platform | string;
  release: string;
  arch: NodeJS.Architecture | string;
  nodeVersion: string;
  nodeMajor: number;
  packageVersion: string;
  hash: string;
}

export interface SandboxExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  timedOut: boolean;
  errorMessage?: string;
}

export interface EnvironmentSecurityState {
  fingerprint: EnvironmentFingerprint;
  matchedFingerprint?: EnvironmentFingerprintRecord;
  isTrusted: boolean;
  issues: string[];
  sandboxResult: SandboxExecutionResult;
  safeMode: boolean;
  policyApplied: 'trusted' | 'safe-mode';
  timestamp: string;
}

export interface EnvironmentSecuritySummary {
  trusted: boolean;
  safeMode: boolean;
  fingerprint: string;
  matchedFingerprint?: string;
  issues: string[];
}

export interface PolicyEnvelope {
  onUnknownEnvironment: 'safe-mode' | 'allow';
  onSandboxFailure: 'safe-mode' | 'allow';
  safeModeEnvFlag: string;
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 2000;
const FINGERPRINT_HASH_PREFIX_LENGTH = 8;

const policyEnvelope: PolicyEnvelope = {
  onUnknownEnvironment: 'safe-mode',
  onSandboxFailure: 'safe-mode',
  safeModeEnvFlag: 'ARC_SAFE_MODE'
};

let latestSecurityState: EnvironmentSecurityState | null = null;

/**
 * Return the active environment security policy configuration.
 */
export function getPolicyEnvelope(): PolicyEnvelope {
  return policyEnvelope;
}

/**
 * Collect the current runtime fingerprint for environment trust evaluation.
 */
export function collectEnvironmentFingerprint(): EnvironmentFingerprint {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.replace('v', '').split('.')[0] || '0', 10);
  const packageVersion = process.env.npm_package_version || 'unknown';
  const hash = crypto
    .createHash('sha256')
    .update(`${platform}|${arch}|${nodeMajor}|${packageVersion}`)
    .digest('hex');

  return {
    platform,
    release,
    arch,
    nodeVersion,
    nodeMajor,
    packageVersion,
    hash
  };
}

/**
 * Match a fingerprint against known trusted records.
 */
export function matchFingerprint(
  fingerprint: EnvironmentFingerprint,
  knownFingerprints: EnvironmentFingerprintRecord[] = KNOWN_ENVIRONMENT_FINGERPRINTS
): EnvironmentFingerprintRecord | undefined {
  return knownFingerprints.find(record => {
    //audit Assumption: platform mismatch indicates untrusted; Handling: reject
    if (record.platform && record.platform !== fingerprint.platform) {
      return false;
    }

    //audit Assumption: arch mismatch indicates untrusted; Handling: reject
    if (record.arch && record.arch !== fingerprint.arch) {
      return false;
    }

    //audit Assumption: node major mismatch indicates untrusted; Handling: reject
    if (record.nodeMajors && !record.nodeMajors.includes(fingerprint.nodeMajor)) {
      return false;
    }

    //audit Assumption: package version mismatch indicates untrusted; Handling: reject
    if (record.packageVersions && record.packageVersions.length > 0) {
      if (!record.packageVersions.includes(fingerprint.packageVersion)) {
        return false;
      }
    }

    //audit Assumption: release prefix mismatch indicates untrusted; Handling: reject
    if (record.releasePrefixes && record.releasePrefixes.length > 0) {
      const matchesPrefix = record.releasePrefixes.some(prefix => fingerprint.release.startsWith(prefix));
      if (!matchesPrefix) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Build a human-readable fingerprint summary for logs and diagnostics.
 */
export function summarizeFingerprint(fingerprint: EnvironmentFingerprint): string {
  //audit Assumption: summary strings are safe for logs; Handling: include short hash
  return [
    fingerprint.platform,
    fingerprint.arch,
    `node${fingerprint.nodeMajor}`,
    fingerprint.packageVersion,
    fingerprint.hash.slice(0, FINGERPRINT_HASH_PREFIX_LENGTH)
  ].join(' | ');
}

/**
 * Execute a script in a restricted child process sandbox.
 */
export async function executeInSandbox(
  script: string,
  timeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS
): Promise<SandboxExecutionResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production'
      }
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let timedOut = false;

    const finish = (result: SandboxExecutionResult) => {
      //audit Assumption: finish should resolve once; Handling: guard with resolved flag
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const timeoutHandle = setTimeout(() => {
      //audit Assumption: sandbox timeout enforces safety; Handling: kill process
      timedOut = true;
      child.kill('SIGKILL');
      finish({
        success: false,
        stdout,
        stderr,
        timedOut,
        errorMessage: 'Sandbox execution timed out'
      });
    }, timeoutMs);

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', err => {
      //audit Assumption: child errors should fail closed; Handling: mark failure
      clearTimeout(timeoutHandle);
      finish({
        success: false,
        stdout,
        stderr: stderr + (err.message || ''),
        exitCode: null,
        timedOut,
        errorMessage: err.message
      });
    });

    child.on('close', code => {
      clearTimeout(timeoutHandle);
      //audit Assumption: exit code 0 is success; Handling: mark failure otherwise
      const success = !timedOut && code === 0;
      finish({
        success,
        stdout,
        stderr,
        exitCode: code ?? undefined,
        timedOut,
        errorMessage: success ? undefined : stderr.trim() || `Sandbox exited with code ${code}`
      });
    });
  });
}

async function probeRuntimeApis(): Promise<{ issues: string[]; sandbox: SandboxExecutionResult }> {
  const sandbox = await executeInSandbox(
    RUNTIME_PROBE_SUMMARY_SCRIPT.trim()
  );

  const issues: string[] = [];

  //audit Assumption: failed sandbox means unknown runtime; Handling: report issue
  if (!sandbox.success) {
    issues.push('Sandboxed runtime probe failed');
    return { issues, sandbox };
  }

  try {
    const parsed = JSON.parse(sandbox.stdout.trim() || '{}');
    //audit Assumption: runtime must expose fetch; Handling: flag missing capability
    if (!parsed.hasFetch) {
      issues.push('Fetch API not available in runtime');
    }
    //audit Assumption: runtime must expose Intl; Handling: flag missing capability
    if (!parsed.hasIntl) {
      issues.push('Intl API not available in runtime');
    }
  } catch (error: unknown) {
    //audit Assumption: parse failure indicates unreliable runtime; Handling: report
    issues.push(`Failed to parse sandbox response: ${getErrorMessage(error) || 'unknown error'}`);
  }

  return { issues, sandbox };
}

async function enforceSafeMode(): Promise<void> {
  process.env[policyEnvelope.safeModeEnvFlag] = 'true';

  //audit Assumption: no DB means no persistence required; Handling: early return
  if (!process.env.DATABASE_URL) {
    return;
  }

  try {
    await setAuditSafeMode('true');
  } catch (error: unknown) {
    //audit Assumption: persistence failure should not crash; Handling: warn log
    logger.warn('Failed to persist audit-safe mode while enforcing policy', {
      error: getErrorMessage(error) || error
    });
  }
}

function disableSafeModeFlag(): void {
  process.env[policyEnvelope.safeModeEnvFlag] = 'false';
}

/**
 * Return the most recent environment security state snapshot.
 */
export function getEnvironmentSecurityState(): EnvironmentSecurityState | null {
  return latestSecurityState;
}

/**
 * Evaluate environment security and apply safe-mode policy if needed.
 */
export async function initializeEnvironmentSecurity(): Promise<EnvironmentSecurityState> {
  const fingerprint = collectEnvironmentFingerprint();
  const matchedFingerprint = matchFingerprint(fingerprint);
  const { issues: probeIssues, sandbox } = await probeRuntimeApis();

  const issues: string[] = [];
  //audit Assumption: unknown fingerprint is risky; Handling: flag issue
  if (!matchedFingerprint) {
    issues.push('Unknown environment fingerprint detected');
  }
  issues.push(...probeIssues);

  let safeMode = false;
  let policyApplied: 'trusted' | 'safe-mode' = 'trusted';

  //audit Assumption: unknown environment triggers safe mode; Handling: set policy
  if (!matchedFingerprint && policyEnvelope.onUnknownEnvironment === 'safe-mode') {
    safeMode = true;
    policyApplied = 'safe-mode';
  }

  //audit Assumption: sandbox issues trigger safe mode; Handling: set policy
  if (probeIssues.length > 0 && policyEnvelope.onSandboxFailure === 'safe-mode') {
    safeMode = true;
    policyApplied = 'safe-mode';
  }

  //audit Assumption: safe mode applies protective configuration; Handling: enforce
  if (safeMode) {
    await enforceSafeMode();
    logger.warn('Environment security policy applied: safe mode enabled', {
      fingerprint: summarizeFingerprint(fingerprint),
      issues
    });
  } else {
    //audit Assumption: trusted environment allows normal operation; Handling: log
    disableSafeModeFlag();
    logger.info('Trusted environment fingerprint confirmed', {
      fingerprint: summarizeFingerprint(fingerprint),
      matchedFingerprint: matchedFingerprint?.id
    });
  }

  const state: EnvironmentSecurityState = {
    fingerprint,
    matchedFingerprint,
    isTrusted: !safeMode,
    issues,
    sandboxResult: sandbox,
    safeMode,
    policyApplied,
    timestamp: new Date().toISOString()
  };

  latestSecurityState = state;
  return state;
}

/**
 * Return a summary view of the current security state for reporting.
 */
export function getEnvironmentSecuritySummary(): EnvironmentSecuritySummary | null {
  if (!latestSecurityState) {
    return null;
  }

  //audit Assumption: summary omits sensitive details; Handling: return safe fields
  return {
    trusted: latestSecurityState.isTrusted,
    safeMode: latestSecurityState.safeMode,
    fingerprint: summarizeFingerprint(latestSecurityState.fingerprint),
    matchedFingerprint: latestSecurityState.matchedFingerprint?.id,
    issues: latestSecurityState.issues
  };
}

function getErrorMessage(error: unknown): string | undefined {
  //audit Assumption: extract a usable error string; Handling: layered checks
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return undefined;
}
