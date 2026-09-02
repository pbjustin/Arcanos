import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ipKeyGenerator } from 'express-rate-limit';

type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

type AuditVulnerability = {
  name: string;
  severity: Severity;
  via: Array<
    | string
    | {
        name: string;
        dependency: string;
        severity: Severity;
        source: number;
        url: string;
      }
  >;
  nodes: string[];
  fixAvailable: boolean | Record<string, unknown>;
};

const auditPolicyScriptPath = fileURLToPath(
  new URL('../scripts/check-npm-audit.js', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const severities: Severity[] = [
  'info',
  'low',
  'moderate',
  'high',
  'critical',
];

function runAuditScript(args: string[]) {
  return spawnSync(process.execPath, [auditPolicyScriptPath, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
}

function runAuditReportText(reportText: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-audit-policy-'));
  const reportPath = path.join(directory, 'audit.json');

  try {
    writeFileSync(reportPath, reportText, 'utf8');
    return runAuditScript([reportPath]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runAuditReport(report: unknown) {
  return runAuditReportText(JSON.stringify(report));
}

function completeAuditReport(
  vulnerabilities: Record<string, unknown>,
): Record<string, unknown> {
  const counts: Record<Severity | 'total', number> = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: Object.keys(vulnerabilities).length,
  };

  for (const vulnerability of Object.values(vulnerabilities)) {
    if (
      vulnerability &&
      typeof vulnerability === 'object' &&
      !Array.isArray(vulnerability) &&
      'severity' in vulnerability &&
      severities.includes(vulnerability.severity as Severity)
    ) {
      counts[vulnerability.severity as Severity] += 1;
    }
  }

  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: counts },
  };
}

function advisory(
  name: string,
  severity: Severity = 'high',
): AuditVulnerability {
  return {
    name,
    severity,
    via: [
      {
        name,
        dependency: name,
        severity,
        source: 9_999_999,
        url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
      },
    ],
    nodes: [`node_modules/${name}`],
    fixAvailable: false,
  };
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

describe('npm audit policy', () => {
  it('accepts a complete clean audit report without exceptions', () => {
    const result = runAuditReport(completeAuditReport({}));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseStdout(result)).toEqual({
      auditReportVersion: 2,
      ignored: [],
      actionable: [],
    });
  });

  it.each(severities)('makes every %s vulnerability actionable', severity => {
    const vulnerability = advisory('unexpected-package', severity);
    const result = runAuditReport(
      completeAuditReport({ 'unexpected-package': vulnerability }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(parseStdout(result)).toEqual({
      auditReportVersion: 2,
      ignored: [],
      actionable: [
        {
          name: 'unexpected-package',
          severity,
          via: [
            {
              name: 'unexpected-package',
              source: 9_999_999,
              url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
            },
          ],
          fixAvailable: false,
          nodes: ['node_modules/unexpected-package'],
        },
      ],
    });
  });

  it.each(['brace-expansion', 'fast-uri', 'ip-address', 'undici'])(
    'does not retain an exception for %s',
    packageName => {
      const vulnerability = advisory(packageName);
      const result = runAuditReport(
        completeAuditReport({ [packageName]: vulnerability }),
      );

      expect(result.status).toBe(1);
      expect(parseStdout(result)).toMatchObject({
        ignored: [],
        actionable: [{ name: packageName, severity: 'high' }],
      });
    },
  );

  it('preserves direct and propagated evidence for actionable findings', () => {
    const direct = advisory('direct-package', 'critical');
    direct.fixAvailable = {
      name: 'direct-package',
      version: '2.0.0',
      isSemVerMajor: true,
    };
    const propagated: AuditVulnerability = {
      name: 'parent-package',
      severity: 'critical',
      via: ['direct-package'],
      nodes: ['node_modules/parent-package'],
      fixAvailable: true,
    };
    const result = runAuditReport(
      completeAuditReport({
        'direct-package': direct,
        'parent-package': propagated,
      }),
    );

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable).toEqual([
      expect.objectContaining({
        name: 'direct-package',
        severity: 'critical',
        fixAvailable: {
          name: 'direct-package',
          version: '2.0.0',
          isSemVerMajor: true,
        },
        nodes: ['node_modules/direct-package'],
      }),
      {
        name: 'parent-package',
        severity: 'critical',
        via: ['direct-package'],
        fixAvailable: true,
        nodes: ['node_modules/parent-package'],
      },
    ]);
  });

  it.each([
    null,
    [],
    {},
    { auditReportVersion: 1, vulnerabilities: {}, metadata: {} },
    { auditReportVersion: 2, vulnerabilities: {} },
    {
      auditReportVersion: 2,
      vulnerabilities: [],
      metadata: { vulnerabilities: {} },
    },
    {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: { vulnerabilities: { total: 0 } },
    },
  ])('fails closed for an incomplete report: %p', report => {
    const result = runAuditReport(report);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'npm audit report is not a complete version 2 vulnerability report',
    );
  });

  it('fails closed when metadata counts contradict vulnerability records', () => {
    const report = completeAuditReport({ package: advisory('package', 'high') });
    const metadata = report.metadata as {
      vulnerabilities: Record<string, number>;
    };
    metadata.vulnerabilities.high = 0;
    metadata.vulnerabilities.low = 1;
    const result = runAuditReport(report);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'npm audit report is not a complete version 2 vulnerability report',
    );
  });

  it('fails closed for an unrecognized vulnerability severity', () => {
    const report = completeAuditReport({ package: advisory('package') });
    (report.vulnerabilities as Record<string, AuditVulnerability>)[
      'package'
    ].severity = 'unknown' as Severity;
    const result = runAuditReport(report);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'npm audit report is not a complete version 2 vulnerability report',
    );
  });

  it('fails closed for empty, malformed, missing, or omitted input', () => {
    const empty = runAuditReportText('');
    const malformed = runAuditReportText('{');
    const missing = runAuditScript([
      path.join(tmpdir(), 'arcanos-missing-audit-report.json'),
    ]);
    const omitted = runAuditScript([]);

    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('npm audit report is empty');
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain('npm audit report is not valid JSON');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('npm audit report is missing or unreadable');
    expect(omitted.status).toBe(1);
    expect(omitted.stderr).toContain(
      'Usage: node scripts/check-npm-audit.js <audit-report.json>',
    );
  });

  it('pins patched dependency artifacts and unchanged parent packages', () => {
    const rootPackage = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
    );
    const runtimePackage = JSON.parse(
      readFileSync(
        path.join(repositoryRoot, 'arcanos-ai-runtime/package.json'),
        'utf8',
      ),
    );
    const vendorPackage = JSON.parse(
      readFileSync(
        path.join(repositoryRoot, 'vendor/minimatch-9.0.7/package.json'),
        'utf8',
      ),
    );
    const packageLock = JSON.parse(
      readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
    );
    const runtimePackageLock = JSON.parse(
      readFileSync(
        path.join(repositoryRoot, 'arcanos-ai-runtime/package-lock.json'),
        'utf8',
      ),
    );

    const fastUriArtifact = {
      version: '3.1.7',
      resolved:
        'https://codeload.github.com/fastify/fast-uri/tar.gz/412e40abd4eb8beabfb952d80abf949a2baf27a3',
      integrity:
        'sha512-5unwS9zaFqbeaj/WllGpj11NYZg78jpAM8leZ+xZvL4p1Vc6QFMS6Bpd84SN4jzkWsPCgZT7ilSHpn542Kp8Mg==',
    };
    const qsArtifact = {
      version: '6.16.0',
      resolved:
        'https://codeload.github.com/ljharb/qs/tar.gz/bb9379e01fad04c601478acd6152143cb20c984b',
      integrity:
        'sha512-fkOHat/7xtPQRrpGGvW5ua3EeevYbTiV3GSIhUdL5ocT+sNZu374dFCheYnSzk/EqpYN5SY9my8bSRBGoISxVA==',
    };

    expect(rootPackage.overrides).toMatchObject({
      'express-rate-limit': '8.3.0',
      'fast-uri': fastUriArtifact.resolved,
      'ip-address': '10.3.1',
      qs: qsArtifact.resolved,
      undici: '7.29.0',
    });
    expect(runtimePackage.overrides).toMatchObject({
      qs: qsArtifact.resolved,
    });
    expect(rootPackage.overrides['brace-expansion']).toBeUndefined();
    expect(vendorPackage.dependencies['brace-expansion']).toBe('5.0.9');

    const expectedLockIdentities = {
      'vendor/minimatch-9.0.7/node_modules/brace-expansion': {
        version: '5.0.9',
        resolved:
          'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz',
        integrity:
          'sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==',
      },
      'node_modules/express-rate-limit': {
        version: '8.3.0',
        resolved:
          'https://registry.npmjs.org/express-rate-limit/-/express-rate-limit-8.3.0.tgz',
        integrity:
          'sha512-KJzBawY6fB9FiZGdE/0aftepZ91YlaGIrV8vgblRM3J8X+dHx/aiowJWwkx6LIGyuqGiANsjSwwrbb8mifOJ4Q==',
      },
      'node_modules/fast-uri': fastUriArtifact,
      'node_modules/ip-address': {
        version: '10.3.1',
        resolved:
          'https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz',
        integrity:
          'sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==',
      },
      'node_modules/undici': {
        version: '7.29.0',
        resolved:
          'https://registry.npmjs.org/undici/-/undici-7.29.0.tgz',
        integrity:
          'sha512-IDxfleLmmbSskfWSUATiN1nfn2rDuvnMOqb5CWR92iIfojA0Ud+ulOAAEQ57LPr9rWmsreUyf5lwyao+7GNNVw==',
      },
      'node_modules/qs': qsArtifact,
    };
    for (const [node, identity] of Object.entries(expectedLockIdentities)) {
      expect(packageLock.packages[node]).toMatchObject(identity);
    }

    expect(packageLock.packages['node_modules/@modelcontextprotocol/sdk'].version).toBe(
      '1.30.0',
    );
    expect(packageLock.packages['node_modules/ajv'].version).toBe('8.18.0');
    expect(packageLock.packages['node_modules/cheerio'].version).toBe('1.1.2');
    expect(runtimePackageLock.packages['node_modules/qs']).toMatchObject(
      qsArtifact,
    );
    expect(runtimePackageLock.packages['node_modules/express'].version).toBe(
      '4.22.2',
    );
    expect(runtimePackageLock.packages['node_modules/body-parser'].version).toBe(
      '1.20.6',
    );
  });

  it('preserves mapped IPv4 identities and IPv6 subnet grouping', () => {
    expect(ipKeyGenerator('::ffff:203.0.113.10', 64)).toBe('203.0.113.10');
    expect(ipKeyGenerator('::ffff:203.0.113.11', 64)).toBe('203.0.113.11');

    const firstSubnetKey = ipKeyGenerator('2001:db8:abcd:12::1', 64);
    const sameSubnetKey = ipKeyGenerator('2001:db8:abcd:12:ffff::2', 64);
    const otherSubnetKey = ipKeyGenerator('2001:db8:abcd:13::1', 64);

    expect(firstSubnetKey).toBe('2001:db8:abcd:12::/64');
    expect(sameSubnetKey).toBe(firstSubnetKey);
    expect(otherSubnetKey).toBe('2001:db8:abcd:13::/64');
    expect(otherSubnetKey).not.toBe(firstSubnetKey);
  });

  it('contains no temporary npm vulnerability exception registry', () => {
    const policy = readFileSync(auditPolicyScriptPath, 'utf8');

    expect(policy).not.toMatch(/temporaryDirectExceptions/);
    expect(policy).not.toMatch(/temporaryPropagatedExceptions/);
    expect(policy).not.toMatch(/Review no later than 2026-08-10/);
    expect(policy).not.toMatch(/GHSA-/);
    expect(policy).not.toMatch(/candidate package-lock\.json/);
  });

  it.each(['.github/workflows/ci-cd.yml', '.github/workflows/arcanos-release.yml'])(
    'makes the fail-closed repository policy authoritative in %s',
    workflowPath => {
      const workflow = readFileSync(
        path.join(repositoryRoot, workflowPath),
        'utf8',
      );

      expect(workflow).toContain('audit_exit=0');
      expect(workflow).toContain('|| audit_exit=$?');
      expect(workflow).toContain(
        'Production npm audit policy passed (raw npm exit=$audit_exit)',
      );
      expect(workflow).not.toContain('policy_exit=0');
      expect(workflow).not.toContain('|| policy_exit=$?');
      expect(workflow).not.toContain('audit_exit != 0');
      expect(workflow).not.toMatch(/npm audit[^\n]*\|\|\s*true/);
      if (workflowPath === '.github/workflows/ci-cd.yml') {
        expect(workflow).toContain(
          'node scripts/check-npm-audit.js npm-audit.json',
        );
      } else {
        expect(workflow).toContain(
          'node "$AUDIT_POLICY_PATH" npm-audit.json',
        );
      }
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
});
