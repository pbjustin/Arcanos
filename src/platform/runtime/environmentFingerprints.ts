export interface EnvironmentFingerprintRecord {
  /** Unique identifier for the known environment */
  id: string;
  /** Friendly label for logging and diagnostics */
  label: string;
  /** Expected operating system platform */
  platform: NodeJS.Platform | string;
  /** Expected CPU architecture */
  arch: NodeJS.Architecture | string;
  /** Supported major versions of Node.js */
  nodeMajors: number[];
  /** Optional application package versions that are considered safe */
  packageVersions?: string[];
  /** Optional operating system release prefixes that are considered safe */
  releasePrefixes?: string[];
}

/**
 * Catalog of known-good deployment environments.
 *
 * These fingerprints allow ARCANOS to compare the live runtime against
 * configurations that have been formally validated. When the current
 * environment does not match any of these fingerprints, ARCANOS will
 * automatically fall back to safe mode safeguards.
 */
export const KNOWN_ENVIRONMENT_FINGERPRINTS: EnvironmentFingerprintRecord[] = [
  {
    id: 'arc-docker-node-24',
    label: 'ARCANOS Docker baseline (Node 24.x, Linux x64)',
    platform: 'linux',
    arch: 'x64',
    nodeMajors: [24],
    releasePrefixes: ['5', '6'],
    packageVersions: ['1.0.0', '1.1.0']
  },
  {
    id: 'railway-node-24',
    label: 'Railway managed deployment (Node 24.x, Linux x64)',
    platform: 'linux',
    arch: 'x64',
    nodeMajors: [24],
    releasePrefixes: ['5', '6']
  },
  {
    id: 'dev-macos-node-24',
    label: 'Local development (macOS, Node 24.x)',
    platform: 'darwin',
    arch: 'x64',
    nodeMajors: [24],
    releasePrefixes: ['22', '23']
  },
  {
    id: 'dev-windows-node-24',
    label: 'Local development (Windows, Node 24.x)',
    platform: 'win32',
    arch: 'x64',
    nodeMajors: [24],
    releasePrefixes: ['10']
  }
];
