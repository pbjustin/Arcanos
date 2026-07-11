import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type AuditVulnerability = {
  severity: string;
  via: Array<string | { name: string; source: number; url: string }>;
  nodes: string[];
  fixAvailable: boolean;
};

const auditPolicyScriptPath = fileURLToPath(
  new URL('../scripts/check-npm-audit.js', import.meta.url),
);

function runAuditPolicy(vulnerabilities: Record<string, AuditVulnerability>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-audit-policy-'));
  const reportPath = path.join(directory, 'audit.json');

  try {
    writeFileSync(
      reportPath,
      JSON.stringify({ auditReportVersion: 2, vulnerabilities }),
      'utf8',
    );

    return spawnSync(process.execPath, [auditPolicyScriptPath, reportPath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

function advisory(name: string, severity: 'high' | 'critical', source: number, ghsa: string) {
  return {
    severity,
    via: [
      {
        name,
        source,
        url: `https://github.com/advisories/${ghsa}`,
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

  it.each(['high', 'critical'] as const)(
    'fails for an unexpected %s advisory',
    severity => {
      const result = runAuditPolicy({
        'unexpected-package': advisory(
          'unexpected-package',
          severity,
          9_999_999,
          'GHSA-xxxx-yyyy-zzzz',
        ),
      });

      expect(result.status).toBe(1);
      expect(parseStdout(result).actionable).toHaveLength(1);
    },
  );

  it('fails for an unexpected advisory on an otherwise excepted package', () => {
    const result = runAuditPolicy({
      axios: advisory('axios', 'high', 9_999_998, 'GHSA-neww-advi-sory'),
    });

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable[0].name).toBe('axios');
  });

  it.each([
    ['uuid', 1_116_970, 'GHSA-w5hq-g745-h8pq'],
    ['qs', 1_119_502, 'GHSA-q8mj-m7cp-5q26'],
    ['axios', 1_119_667, 'GHSA-pjwm-pj3p-43mv'],
  ] as const)('no longer suppresses the remediated %s advisory', (name, source, ghsa) => {
    const result = runAuditPolicy({
      [name]: advisory(name, 'high', source, ghsa),
    });

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable[0].name).toBe(name);
  });

  it('retains the source-scoped exception for blocked lodash advisories', () => {
    const result = runAuditPolicy({
      lodash: advisory('lodash', 'high', 1_115_806, 'GHSA-r5fr-rjxr-66jc'),
    });

    expect(result.status).toBe(0);
    expect(parseStdout(result).ignored[0].name).toBe('lodash');
  });
});
