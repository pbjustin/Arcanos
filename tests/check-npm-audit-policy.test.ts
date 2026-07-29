import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type AuditVulnerability = {
  severity: string;
  via: Array<string | { name: string; source: number; url: string }>;
  nodes: string[];
  fixAvailable: boolean | Record<string, unknown>;
};

const auditPolicyScriptPath = fileURLToPath(
  new URL('../scripts/check-npm-audit.js', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function runAuditReport(report: unknown) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-audit-policy-'));
  const reportPath = path.join(directory, 'audit.json');

  try {
    writeFileSync(reportPath, JSON.stringify(report), 'utf8');

    return spawnSync(process.execPath, [auditPolicyScriptPath, reportPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runAuditPolicy(vulnerabilities: Record<string, unknown>) {
  const counts = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: Object.keys(vulnerabilities).length,
  };

  for (const vulnerability of Object.values(vulnerabilities)) {
    const severity =
      vulnerability &&
      typeof vulnerability === 'object' &&
      !Array.isArray(vulnerability) &&
      'severity' in vulnerability &&
      typeof vulnerability.severity === 'string'
        ? vulnerability.severity
        : 'high';

    if (severity in counts && severity !== 'total') {
      counts[severity as keyof Omit<typeof counts, 'total'>] += 1;
    } else {
      counts.high += 1;
    }
  }

  return runAuditReport({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: counts },
  });
}

function parseStdout(result: { stdout: string; stderr: string }) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      [
        'Failed to parse audit policy output as JSON.',
        `Stdout: ${result.stdout || '<empty>'}`,
        `Stderr: ${result.stderr || '<empty>'}`,
      ].join('\n'),
    );
  }
}

function advisory(
  name: string,
  severity: 'low' | 'moderate' | 'high' | 'critical' = 'high',
): AuditVulnerability {
  return {
    severity,
    via: [
      {
        name,
        source: 9_999_999,
        url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
      },
    ],
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
}

describe('npm audit policy', () => {
  it('includes child-process output when policy JSON parsing fails', () => {
    expect(() => parseStdout({ stdout: '', stderr: 'spawn failed' })).toThrow(
      'Failed to parse audit policy output as JSON.\n' +
        'Stdout: <empty>\n' +
        'Stderr: spawn failed',
    );
  });

  it('accepts only a complete version 2 report with no production vulnerabilities', () => {
    const result = runAuditPolicy({});

    expect(result.status).toBe(0);
    expect(parseStdout(result)).toEqual({
      auditReportVersion: 2,
      actionable: [],
    });
  });

  it.each([
    ['axios', 'high'],
    ['lodash', 'high'],
    ['knex', 'high'],
    ['@hono/node-server', 'moderate'],
    ['hono', 'moderate'],
    ['@modelcontextprotocol/sdk', 'moderate'],
    ['unexpected-package', 'low'],
  ] as const)('fails for a %s vulnerability with no package exceptions', (name, severity) => {
    const result = runAuditPolicy({ [name]: advisory(name, severity) });
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(output.actionable).toHaveLength(1);
    expect(output.actionable[0].name).toBe(name);
    expect(output.actionable[0].severity).toBe(severity);
    expect(output).not.toHaveProperty('ignored');
  });

  it('preserves dependency paths, fixes, and direct and propagated advisory evidence', () => {
    const vulnerability = advisory('example-package', 'critical');
    vulnerability.via.push('propagated-package');
    vulnerability.nodes.push('node_modules/parent/node_modules/example-package');
    vulnerability.fixAvailable = {
      name: 'example-package',
      version: '2.0.0',
      isSemVerMajor: true,
    };

    const result = runAuditPolicy({ 'example-package': vulnerability });
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(output.actionable[0]).toEqual({
      name: 'example-package',
      severity: 'critical',
      via: [
        {
          name: 'example-package',
          source: 9_999_999,
          url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
        },
        'propagated-package',
      ],
      fixAvailable: {
        name: 'example-package',
        version: '2.0.0',
        isSemVerMajor: true,
      },
      nodes: [
        'node_modules/example-package',
        'node_modules/parent/node_modules/example-package',
      ],
    });
  });

  it.each([
    null,
    [],
    {},
    { auditReportVersion: 1, vulnerabilities: {} },
    { auditReportVersion: 2 },
    { auditReportVersion: 2, vulnerabilities: null },
    { auditReportVersion: 2, vulnerabilities: [] },
    { auditReportVersion: 2, vulnerabilities: {} },
    {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 1,
          critical: 0,
          total: 1,
        },
      },
    },
    {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
          total: 1,
        },
      },
    },
  ])('fails closed for an incomplete or malformed audit report: %p', report => {
    const result = runAuditReport(report);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'npm audit report is not a complete version 2 vulnerability report',
    );
  });

  it('treats a malformed vulnerability entry as actionable', () => {
    const result = runAuditPolicy({ 'malformed-package': null });

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable[0]).toEqual({
      name: 'malformed-package',
      severity: 'unknown',
      via: [],
      fixAvailable: null,
      nodes: [],
    });
  });

  it.each(['.github/workflows/ci-cd.yml', '.github/workflows/arcanos-release.yml'])(
    'requires both npm and policy success in %s',
    workflowPath => {
      const workflow = readFileSync(
        path.join(repositoryRoot, workflowPath),
        'utf8',
      );

      expect(workflow).toContain('audit_exit=0');
      expect(workflow).toContain('|| audit_exit=$?');
      expect(workflow).toContain('policy_exit=0');
      expect(workflow).toContain('|| policy_exit=$?');
      expect(workflow).toContain('audit_exit != 0 || policy_exit != 0');
      expect(workflow).not.toMatch(/npm audit[^\n]*\|\|\s*true/);
    },
  );

  it.each(['.github/workflows/ci-cd.yml', '.github/workflows/arcanos-release.yml'])(
    'pins Python audit tooling and has no vulnerability ignores in %s',
    workflowPath => {
      const workflow = readFileSync(
        path.join(repositoryRoot, workflowPath),
        'utf8',
      );

      expect(workflow).toContain('"pip-audit==2.10.1"');
      expect(workflow).toMatch(
        /python -m pip_audit(?:\s*\\)?\s+--requirement daemon-python\/requirements\.txt/,
      );
      expect(workflow).not.toContain('--ignore-vuln');
    },
  );

  it('locks the vendored brace-expansion patch to its immutable commit', () => {
    const expectedDependency =
      'git+https://github.com/juliangruber/brace-expansion.git#96a63c0011c0288846ad41773c73e3fbd0906b59';
    const vendorPackage = JSON.parse(
      readFileSync(
        path.join(repositoryRoot, 'vendor/minimatch-9.0.7/package.json'),
        'utf8',
      ),
    );
    const packageLock = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
    );
    const lockedVendor = packageLock.packages['vendor/minimatch-9.0.7'];
    const lockedBraceExpansion =
      packageLock.packages[
        'vendor/minimatch-9.0.7/node_modules/brace-expansion'
      ];

    expect(vendorPackage.dependencies['brace-expansion']).toBe(expectedDependency);
    expect(lockedVendor.dependencies['brace-expansion']).toBe(expectedDependency);
    expect(lockedBraceExpansion.version).toBe('5.0.8');
    expect(lockedBraceExpansion.resolved).toContain(
      'github.com/juliangruber/brace-expansion.git#96a63c0011c0288846ad41773c73e3fbd0906b59',
    );
  });
});
