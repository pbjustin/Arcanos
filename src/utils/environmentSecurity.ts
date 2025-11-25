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

const policyEnvelope: PolicyEnvelope = {
  onUnknownEnvironment: 'safe-mode',
  onSandboxFailure: 'safe-mode',
  safeModeEnvFlag: 'ARC_SAFE_MODE'
};

let latestSecurityState: EnvironmentSecurityState | null = null;

export function getPolicyEnvelope(): PolicyEnvelope {
  return policyEnvelope;
}

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

export function matchFingerprint(
  fingerprint: EnvironmentFingerprint,
  knownFingerprints: EnvironmentFingerprintRecord[] = KNOWN_ENVIRONMENT_FINGERPRINTS
): EnvironmentFingerprintRecord | undefined {
  return knownFingerprints.find(record => {
    if (record.platform && record.platform !== fingerprint.platform) {
      return false;
    }

    if (record.arch && record.arch !== fingerprint.arch) {
      return false;
    }

    if (record.nodeMajors && !record.nodeMajors.includes(fingerprint.nodeMajor)) {
      return false;
    }

    if (record.packageVersions && record.packageVersions.length > 0) {
      if (!record.packageVersions.includes(fingerprint.packageVersion)) {
        return false;
      }
    }

    if (record.releasePrefixes && record.releasePrefixes.length > 0) {
      const matchesPrefix = record.releasePrefixes.some(prefix => fingerprint.release.startsWith(prefix));
      if (!matchesPrefix) {
        return false;
      }
    }

    return true;
  });
}

export function summarizeFingerprint(fingerprint: EnvironmentFingerprint): string {
  return [
    fingerprint.platform,
    fingerprint.arch,
    `node${fingerprint.nodeMajor}`,
    fingerprint.packageVersion,
    fingerprint.hash.slice(0, 8)
  ].join(' | ');
}

export async function executeInSandbox(
  script: string,
  timeoutMs = 2000
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
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const timeoutHandle = setTimeout(() => {
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

  if (!sandbox.success) {
    issues.push('Sandboxed runtime probe failed');
    return { issues, sandbox };
  }

  try {
    const parsed = JSON.parse(sandbox.stdout.trim() || '{}');
    if (!parsed.hasFetch) {
      issues.push('Fetch API not available in runtime');
    }
    if (!parsed.hasIntl) {
      issues.push('Intl API not available in runtime');
    }
  } catch (error: any) {
    issues.push(`Failed to parse sandbox response: ${error?.message || 'unknown error'}`);
  }

  return { issues, sandbox };
}

async function enforceSafeMode(): Promise<void> {
  process.env[policyEnvelope.safeModeEnvFlag] = 'true';

  if (!process.env.DATABASE_URL) {
    return;
  }

  try {
    await setAuditSafeMode('true');
  } catch (error: any) {
    logger.warn('Failed to persist audit-safe mode while enforcing policy', {
      error: error?.message || error
    });
  }
}

function disableSafeModeFlag(): void {
  process.env[policyEnvelope.safeModeEnvFlag] = 'false';
}

export function getEnvironmentSecurityState(): EnvironmentSecurityState | null {
  return latestSecurityState;
}

export async function initializeEnvironmentSecurity(): Promise<EnvironmentSecurityState> {
  const fingerprint = collectEnvironmentFingerprint();
  const matchedFingerprint = matchFingerprint(fingerprint);
  const { issues: probeIssues, sandbox } = await probeRuntimeApis();

  const issues: string[] = [];
  if (!matchedFingerprint) {
    issues.push('Unknown environment fingerprint detected');
  }
  issues.push(...probeIssues);

  let safeMode = false;
  let policyApplied: 'trusted' | 'safe-mode' = 'trusted';

  if (!matchedFingerprint && policyEnvelope.onUnknownEnvironment === 'safe-mode') {
    safeMode = true;
    policyApplied = 'safe-mode';
  }

  if (probeIssues.length > 0 && policyEnvelope.onSandboxFailure === 'safe-mode') {
    safeMode = true;
    policyApplied = 'safe-mode';
  }

  if (safeMode) {
    await enforceSafeMode();
    logger.warn('Environment security policy applied: safe mode enabled', {
      fingerprint: summarizeFingerprint(fingerprint),
      issues
    });
  } else {
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

export function getEnvironmentSecuritySummary(): EnvironmentSecuritySummary | null {
  if (!latestSecurityState) {
    return null;
  }

  return {
    trusted: latestSecurityState.isTrusted,
    safeMode: latestSecurityState.safeMode,
    fingerprint: summarizeFingerprint(latestSecurityState.fingerprint),
    matchedFingerprint: latestSecurityState.matchedFingerprint?.id,
    issues: latestSecurityState.issues
  };
}
