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

function advisory(
  name: string,
  severity: 'high' | 'critical',
  source: number,
  ghsa: string,
  nodes = [`node_modules/${name}`],
) {
  return {
    severity,
    via: [
      {
        name,
        source,
        url: `https://github.com/advisories/${ghsa}`,
      },
    ],
    nodes,
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

  it.each([
    [1_123_882, 'GHSA-42h9-826w-cgv3'],
    [1_123_884, 'GHSA-xj6q-8x83-jv6g'],
    [1_123_885, 'GHSA-pmv8-rq9r-6j72'],
    [1_123_957, 'GHSA-jqh4-m9w3-8hp9'],
    [1_123_959, 'GHSA-mmx7-hfxf-jppx'],
    [1_123_961, 'GHSA-f4gw-2p7v-4548'],
    [1_123_967, 'GHSA-gcfj-64vw-6mp9'],
    [1_123_969, 'GHSA-hcpx-6fm6-wx23'],
    [1_123_971, 'GHSA-7q8q-rj6j-mhjq'],
    [1_123_973, 'GHSA-mwf2-3pr3-8698'],
  ] as const)('retains the source-scoped axios exception for %s', (source, ghsa) => {
    const result = runAuditPolicy({
      axios: advisory('axios', 'high', source, ghsa),
    });

    expect(result.status).toBe(0);
    expect(parseStdout(result).ignored[0].name).toBe('axios');
  });

  it('does not suppress a mixed known and unexpected axios advisory set', () => {
    const axiosVulnerability = advisory(
      'axios',
      'high',
      1_123_882,
      'GHSA-42h9-826w-cgv3',
    );
    axiosVulnerability.via.push({
      name: 'axios',
      source: 9_999_996,
      url: 'https://github.com/advisories/GHSA-neww-mixe-sory',
    });
    const result = runAuditPolicy({ axios: axiosVulnerability });

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable[0].name).toBe('axios');
  });

  it('does not suppress an approved axios advisory on a new dependency path', () => {
    const result = runAuditPolicy({
      axios: advisory('axios', 'high', 1_123_882, 'GHSA-42h9-826w-cgv3', [
        'node_modules/unexpected-package/node_modules/axios',
      ]),
    });

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable[0].name).toBe('axios');
  });

  it.each([
    [1_120_311, 'GHSA-jxxr-4gwj-5jf2'],
    [1_123_898, 'GHSA-3jxr-9vmj-r5cp'],
  ] as const)(
    'retains the source-scoped brace-expansion exception for %s',
    (source, ghsa) => {
      const result = runAuditPolicy({
        'brace-expansion': advisory('brace-expansion', 'high', source, ghsa, [
          'vendor/minimatch-9.0.7/node_modules/brace-expansion',
        ]),
      });

      expect(result.status).toBe(0);
      expect(parseStdout(result).ignored[0].name).toBe('brace-expansion');
    },
  );

  it('does not suppress an approved brace-expansion advisory on a production node', () => {
    const result = runAuditPolicy({
      'brace-expansion': advisory(
        'brace-expansion',
        'high',
        1_120_311,
        'GHSA-jxxr-4gwj-5jf2',
      ),
    });

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable[0].name).toBe('brace-expansion');
  });

  it('does not suppress an unexpected brace-expansion advisory on the vendor node', () => {
    const result = runAuditPolicy({
      'brace-expansion': advisory(
        'brace-expansion',
        'high',
        9_999_997,
        'GHSA-neww-brac-sory',
        ['vendor/minimatch-9.0.7/node_modules/brace-expansion'],
      ),
    });

    expect(result.status).toBe(1);
    expect(parseStdout(result).actionable[0].name).toBe('brace-expansion');
  });
});
