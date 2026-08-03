import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type AuditVulnerability = {
  name: string;
  severity: string;
  via: Array<
    | string
    | {
        name: string;
        dependency: string;
        severity: string;
        source: number;
        url: string;
      }
  >;
  nodes: string[];
  fixAvailable: boolean | Record<string, unknown>;
};

type CandidatePackageLock = {
  lockfileVersion?: unknown;
  packages?: Record<string, Record<string, unknown> | null>;
};

const auditPolicyScriptPath = fileURLToPath(
  new URL('../scripts/check-npm-audit.js', import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const temporaryDirectExceptions = [
  {
    name: 'brace-expansion',
    severity: 'high',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-rgw5-rvv9-x895',
        severity: 'high',
      },
    ],
    node: 'vendor/minimatch-9.0.7/node_modules/brace-expansion',
  },
  {
    name: 'fast-uri',
    severity: 'high',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-7p8r-x3mc-p8w7',
        severity: 'high',
      },
    ],
    node: 'node_modules/fast-uri',
  },
  {
    name: 'hono',
    severity: 'moderate',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-8j4g-w8fx-2239',
        severity: 'moderate',
      },
    ],
    node: 'node_modules/hono',
  },
  {
    name: 'ip-address',
    severity: 'high',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-mwp4-54f8-5fhr',
        severity: 'high',
      },
      {
        url: 'https://github.com/advisories/GHSA-4xrf-jv44-h6hh',
        severity: 'moderate',
      },
      {
        url: 'https://github.com/advisories/GHSA-22jq-vg5j-6vgg',
        severity: 'moderate',
      },
    ],
    node: 'node_modules/ip-address',
  },
  {
    name: 'undici',
    severity: 'high',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-8xcm-r25x-g524',
        severity: 'moderate',
      },
      {
        url: 'https://github.com/advisories/GHSA-4cwx-7wf7-3272',
        severity: 'high',
      },
      {
        url: 'https://github.com/advisories/GHSA-m8rv-5g2x-5cg5',
        severity: 'moderate',
      },
      {
        url: 'https://github.com/advisories/GHSA-jr45-8vmc-qm54',
        severity: 'moderate',
      },
      {
        url: 'https://github.com/advisories/GHSA-v3r7-h72x-cjcm',
        severity: 'moderate',
      },
    ],
    node: 'node_modules/undici',
  },
] as const;

const expectedSeverityByPackage = {
  '@hono/node-server': 'moderate',
  '@modelcontextprotocol/sdk': 'high',
  ajv: 'high',
  'brace-expansion': 'high',
  cheerio: 'moderate',
  'express-rate-limit': 'high',
  'fast-uri': 'high',
  hono: 'moderate',
  'ip-address': 'high',
  undici: 'high',
} as const;
const requiredTemporaryExceptionNames = Object.keys(
  expectedSeverityByPackage,
).filter(name => name !== 'brace-expansion');

const directAdvisorySeverityCases = temporaryDirectExceptions.flatMap(
  exception =>
    exception.advisories.map(advisory => ({
      name: exception.name,
      url: advisory.url,
      severity: advisory.severity,
    })),
);

const expectedFixAvailableByPackage = {
  '@hono/node-server': {
    name: '@modelcontextprotocol/sdk',
    version: '1.25.3',
    isSemVerMajor: true,
  },
  '@modelcontextprotocol/sdk': {
    name: '@modelcontextprotocol/sdk',
    version: '1.25.3',
    isSemVerMajor: true,
  },
  ajv: {
    name: 'ajv',
    version: '8.16.0',
    isSemVerMajor: true,
  },
  'brace-expansion': false,
  cheerio: {
    name: 'cheerio',
    version: '1.0.0',
    isSemVerMajor: true,
  },
  'express-rate-limit': true,
  'fast-uri': {
    name: 'ajv',
    version: '8.16.0',
    isSemVerMajor: true,
  },
  hono: {
    name: '@modelcontextprotocol/sdk',
    version: '1.25.3',
    isSemVerMajor: true,
  },
  'ip-address': true,
  undici: {
    name: 'cheerio',
    version: '1.0.0',
    isSemVerMajor: true,
  },
} as const;

const temporaryExceptionLockNodes = [
  'node_modules/@hono/node-server',
  'node_modules/@modelcontextprotocol/sdk',
  'node_modules/ajv',
  'vendor/minimatch-9.0.7/node_modules/brace-expansion',
  'node_modules/cheerio',
  'node_modules/express-rate-limit',
  'node_modules/fast-uri',
  'node_modules/hono',
  'node_modules/ip-address',
  'node_modules/undici',
] as const;
const lockIdentityDriftCases = temporaryExceptionLockNodes.flatMap(node =>
  (['version', 'resolved', 'integrity'] as const).map(field => ({ node, field })),
);

function runAuditReport(report: unknown, candidateLockPath?: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-audit-policy-'));
  const reportPath = path.join(directory, 'audit.json');

  try {
    writeFileSync(reportPath, JSON.stringify(report), 'utf8');
    const args = [auditPolicyScriptPath, reportPath];
    if (candidateLockPath) {
      args.push(candidateLockPath);
    }

    return spawnSync(process.execPath, args, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runAuditPolicy(
  vulnerabilities: Record<string, unknown>,
  candidateLockPath?: string,
) {
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

  return runAuditReport(
    {
      auditReportVersion: 2,
      vulnerabilities,
      metadata: { vulnerabilities: counts },
    },
    candidateLockPath,
  );
}

function runAuditPolicyWithLockText(
  vulnerabilities: Record<string, unknown>,
  lockText: string,
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'arcanos-audit-lock-'));
  const candidateLockPath = path.join(directory, 'package-lock.json');

  try {
    writeFileSync(candidateLockPath, lockText, 'utf8');
    return runAuditPolicy(vulnerabilities, candidateLockPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readCandidateLock(): CandidatePackageLock {
  return JSON.parse(
    readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
  ) as CandidatePackageLock;
}

function runAuditPolicyWithMutatedLock(
  vulnerabilities: Record<string, unknown>,
  mutate: (candidateLock: CandidatePackageLock) => void,
) {
  const candidateLock = readCandidateLock();
  mutate(candidateLock);
  return runAuditPolicyWithLockText(
    vulnerabilities,
    JSON.stringify(candidateLock),
  );
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
  url = 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
  node = `node_modules/${name}`,
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
        url,
      },
    ],
    nodes: [node],
    fixAvailable: false,
  };
}

function exactDirectVulnerability(
  exception: (typeof temporaryDirectExceptions)[number],
): AuditVulnerability {
  const vulnerability = advisory(
    exception.name,
    exception.severity,
    exception.advisories[0].url,
    exception.node,
  );
  vulnerability.via = exception.advisories.map((advisory, index) => ({
    name: exception.name,
    dependency: exception.name,
    severity: advisory.severity,
    source: 9_000_000 + index,
    url: advisory.url,
  }));
  vulnerability.fixAvailable = cloneExpectedFixAvailable(exception.name);
  return vulnerability;
}

function cloneExpectedFixAvailable(name: string) {
  const expected =
    expectedFixAvailableByPackage[
      name as keyof typeof expectedFixAvailableByPackage
    ];
  if (typeof expected === 'boolean') {
    return expected;
  }
  return expected ? { ...expected } : false;
}

function propagatedVulnerability(
  name: string,
  severity: 'low' | 'moderate' | 'high' | 'critical',
  via: string[],
  node: string,
): AuditVulnerability {
  return {
    name,
    severity,
    via,
    nodes: [node],
    fixAvailable: cloneExpectedFixAvailable(name),
  };
}

function currentVulnerabilityGraph(): Record<string, AuditVulnerability> {
  const directVulnerabilities = Object.fromEntries(
    temporaryDirectExceptions.map(exception => [
      exception.name,
      exactDirectVulnerability(exception),
    ]),
  );

  return {
    '@hono/node-server': propagatedVulnerability(
      '@hono/node-server',
      'moderate',
      ['hono'],
      'node_modules/@hono/node-server',
    ),
    '@modelcontextprotocol/sdk': propagatedVulnerability(
      '@modelcontextprotocol/sdk',
      'high',
      ['@hono/node-server', 'ajv', 'express-rate-limit', 'hono'],
      'node_modules/@modelcontextprotocol/sdk',
    ),
    ajv: propagatedVulnerability(
      'ajv',
      'high',
      ['fast-uri'],
      'node_modules/ajv',
    ),
    cheerio: propagatedVulnerability(
      'cheerio',
      'moderate',
      ['undici'],
      'node_modules/cheerio',
    ),
    'express-rate-limit': propagatedVulnerability(
      'express-rate-limit',
      'high',
      ['ip-address'],
      'node_modules/express-rate-limit',
    ),
    ...directVulnerabilities,
  };
}

function completeVulnerabilityGraph(
  overrides: Record<string, AuditVulnerability>,
): Record<string, AuditVulnerability> {
  return { ...currentVulnerabilityGraph(), ...overrides };
}

describe('npm audit policy', () => {
  it('includes child-process output when policy JSON parsing fails', () => {
    expect(() => parseStdout({ stdout: '', stderr: 'spawn failed' })).toThrow(
      'Failed to parse audit policy output as JSON.\n' +
        'Stdout: <empty>\n' +
        'Stderr: spawn failed',
    );
  });

  it('fails closed when a report omits every known temporary advisory record', () => {
    const result = runAuditPolicy({});

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'npm audit report is missing required temporary advisory records',
    );
    for (const name of requiredTemporaryExceptionNames) {
      expect(result.stderr).toContain(name);
    }
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
    const result = runAuditPolicy(
      completeVulnerabilityGraph({ [name]: advisory(name, severity) }),
    );
    const output = parseStdout(result);
    const target = output.actionable.find(
      (entry: { name: string }) => entry.name === name,
    );

    expect(result.status).toBe(1);
    expect(target?.severity).toBe(severity);
  });

  it.each(temporaryDirectExceptions)(
    'temporarily accepts only the registered advisory URLs and node for $name',
    exception => {
      const result = runAuditPolicy(
        completeVulnerabilityGraph({
          [exception.name]: exactDirectVulnerability(exception),
        }),
      );
      const output = parseStdout(result);

      expect(result.status).toBe(0);
      expect(output.actionable).toEqual([]);
      expect(
        output.ignored.map((entry: { name: string }) => entry.name),
      ).toContain(exception.name);
    },
  );

  it('keeps a new advisory on an excepted package actionable', () => {
    const exception = temporaryDirectExceptions.find(
      candidate => candidate.name === 'hono',
    )!;
    const vulnerability = exactDirectVulnerability(exception);
    vulnerability.via.push({
      name: 'hono',
      dependency: 'hono',
      severity: 'moderate',
      source: 9_100_000,
      url: 'https://github.com/advisories/GHSA-new1-new2-new3',
    });

    const result = runAuditPolicy(
      completeVulnerabilityGraph({ hono: vulnerability }),
    );
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(
      output.actionable.map((entry: { name: string }) => entry.name),
    ).toContain('hono');
  });

  it.each(temporaryDirectExceptions)(
    'requires the complete registered advisory URL set for $name',
    exception => {
      const vulnerability = exactDirectVulnerability(exception);
      vulnerability.via.pop();

      const result = runAuditPolicy(
        completeVulnerabilityGraph({ [exception.name]: vulnerability }),
      );
      const output = parseStdout(result);

      expect(result.status).toBe(1);
      expect(
        output.actionable.map((entry: { name: string }) => entry.name),
      ).toContain(exception.name);
    },
  );

  it('keeps an exact advisory URL actionable when its dependency identity differs', () => {
    const exception = temporaryDirectExceptions.find(
      candidate => candidate.name === 'hono',
    )!;
    const vulnerability = exactDirectVulnerability(exception);
    const directAdvisory = vulnerability.via[0];
    if (typeof directAdvisory !== 'string') {
      directAdvisory.dependency = 'different-package';
    }

    const result = runAuditPolicy(
      completeVulnerabilityGraph({ hono: vulnerability }),
    );
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(
      output.actionable.map((entry: { name: string }) => entry.name),
    ).toContain('hono');
  });

  it.each(temporaryDirectExceptions)(
    'keeps $name actionable at any unregistered dependency node',
    exception => {
      const vulnerability = exactDirectVulnerability(exception);
      vulnerability.nodes = [`${exception.node}/unexpected`];

      const result = runAuditPolicy(
        completeVulnerabilityGraph({ [exception.name]: vulnerability }),
      );
      const output = parseStdout(result);

      expect(result.status).toBe(1);
      expect(
        output.actionable.map((entry: { name: string }) => entry.name),
      ).toContain(exception.name);
    },
  );

  it('accepts the exact current direct and propagated vulnerability graph', () => {
    const vulnerabilities = currentVulnerabilityGraph();

    const result = runAuditPolicy(vulnerabilities);
    const output = parseStdout(result);

    expect(result.status).toBe(0);
    expect(output.actionable).toEqual([]);
    expect(
      output.ignored.map((entry: { name: string }) => entry.name).sort(),
    ).toEqual(Object.keys(vulnerabilities).sort());
  });

  it('accepts the npm 10 graph that omits the vendored brace advisory', () => {
    const vulnerabilities = currentVulnerabilityGraph();
    delete vulnerabilities['brace-expansion'];

    const result = runAuditPolicy(vulnerabilities);
    const output = parseStdout(result);

    expect(result.status).toBe(0);
    expect(output.actionable).toEqual([]);
    expect(output.ignored).toHaveLength(9);
  });

  it.each(requiredTemporaryExceptionNames)(
    'fails closed when the audit report omits the known %s record',
    name => {
      const vulnerabilities = currentVulnerabilityGraph();
      delete vulnerabilities[name];

      const result = runAuditPolicy(vulnerabilities);

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'npm audit report is missing required temporary advisory records',
      );
      expect(result.stderr).toContain(name);
    },
  );

  it.each(Object.entries(expectedSeverityByPackage))(
    'requires the exact aggregate severity for %s',
    (name, expectedSeverity) => {
      const vulnerabilities = currentVulnerabilityGraph();
      expect(vulnerabilities[name].severity).toBe(expectedSeverity);
      vulnerabilities[name].severity = 'critical';

      const result = runAuditPolicy(vulnerabilities);
      const output = parseStdout(result);

      expect(result.status).toBe(1);
      expect(
        output.actionable.map((entry: { name: string }) => entry.name),
      ).toContain(name);
    },
  );

  it.each(directAdvisorySeverityCases)(
    'requires the exact advisory severity for $name $url',
    ({ name, url, severity }) => {
      const exception = temporaryDirectExceptions.find(
        candidate => candidate.name === name,
      )!;
      const vulnerability = exactDirectVulnerability(exception);
      const directAdvisory = vulnerability.via.find(
        entry => typeof entry !== 'string' && entry.url === url,
      );
      if (!directAdvisory || typeof directAdvisory === 'string') {
        throw new Error(`Missing direct advisory fixture: ${url}`);
      }
      expect(directAdvisory.severity).toBe(severity);
      directAdvisory.severity = 'critical';

      const result = runAuditPolicy(
        completeVulnerabilityGraph({ [name]: vulnerability }),
      );
      const output = parseStdout(result);

      expect(result.status).toBe(1);
      expect(
        output.actionable.map((entry: { name: string }) => entry.name),
      ).toContain(name);
    },
  );

  it.each(Object.keys(expectedFixAvailableByPackage))(
    'requires the exact current remediation metadata for %s',
    name => {
      const vulnerabilities = currentVulnerabilityGraph();
      const currentFix = vulnerabilities[name].fixAvailable;
      vulnerabilities[name].fixAvailable =
        typeof currentFix === 'boolean'
          ? !currentFix
          : { ...currentFix, version: `${String(currentFix.version)}-changed` };

      const result = runAuditPolicy(vulnerabilities);
      const output = parseStdout(result);

      expect(result.status).toBe(1);
      expect(
        output.actionable.map((entry: { name: string }) => entry.name),
      ).toContain(name);
    },
  );

  it.each([
    '@hono/node-server',
    'ajv',
    'express-rate-limit',
    'hono',
  ])(
    'requires the complete SDK propagation set when %s is missing',
    missingVia => {
      const vulnerabilities = currentVulnerabilityGraph();
      vulnerabilities['@modelcontextprotocol/sdk'].via = vulnerabilities[
        '@modelcontextprotocol/sdk'
      ].via.filter(entry => entry !== missingVia);

      const result = runAuditPolicy(vulnerabilities);
      const output = parseStdout(result);

      expect(result.status).toBe(1);
      expect(
        output.actionable.map((entry: { name: string }) => entry.name),
      ).toEqual(['@modelcontextprotocol/sdk']);
    },
  );

  it.each(lockIdentityDriftCases)(
    'fails closed when $node has a mismatched lock $field',
    ({ node, field }) => {
      const result = runAuditPolicyWithMutatedLock({}, candidateLock => {
        const lockedNode = candidateLock.packages?.[node];
        if (!lockedNode) {
          throw new Error(`Missing test fixture node: ${node}`);
        }
        lockedNode[field] = `${String(lockedNode[field])}-mismatch`;
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'candidate package-lock.json does not match temporary audit exception identities',
      );
    },
  );

  it('fails closed when a registered lock identity is missing', () => {
    const result = runAuditPolicyWithMutatedLock({}, candidateLock => {
      delete candidateLock.packages?.['node_modules/cheerio'];
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'candidate package-lock.json does not match temporary audit exception identities',
    );
  });

  it('fails closed when a registered lock identity is malformed', () => {
    const result = runAuditPolicyWithMutatedLock({}, candidateLock => {
      if (!candidateLock.packages) {
        throw new Error('Missing test fixture packages');
      }
      candidateLock.packages['node_modules/cheerio'] = null;
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'candidate package-lock.json does not match temporary audit exception identities',
    );
  });

  it('fails closed when the candidate lockfile is malformed JSON', () => {
    const result = runAuditPolicyWithLockText({}, '{');

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'candidate package-lock.json is missing or malformed',
    );
  });

  it('keeps propagated findings actionable unless every via edge is ignored', () => {
    const honoException = temporaryDirectExceptions.find(
      candidate => candidate.name === 'hono',
    )!;
    const vulnerabilities = completeVulnerabilityGraph({
      hono: exactDirectVulnerability(honoException),
      '@hono/node-server': propagatedVulnerability(
        '@hono/node-server',
        'moderate',
        ['hono', 'unexpected-package'],
        'node_modules/@hono/node-server',
      ),
    });

    const result = runAuditPolicy(vulnerabilities);
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(
      output.ignored.map((entry: { name: string }) => entry.name),
    ).toContain('hono');
    expect(
      output.actionable.map((entry: { name: string }) => entry.name),
    ).toContain('@hono/node-server');
  });

  it('does not waive a propagated finding without its matching ignored dependency', () => {
    const fastUriException = temporaryDirectExceptions.find(
      candidate => candidate.name === 'fast-uri',
    )!;
    const fastUri = exactDirectVulnerability(fastUriException);
    const directAdvisory = fastUri.via[0];
    if (typeof directAdvisory !== 'string') {
      directAdvisory.url =
        'https://github.com/advisories/GHSA-new1-new2-new3';
    }
    const result = runAuditPolicy(
      completeVulnerabilityGraph({ 'fast-uri': fastUri }),
    );
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(
      output.actionable.map((entry: { name: string }) => entry.name),
    ).toEqual(expect.arrayContaining(['fast-uri', 'ajv']));
  });

  it('keeps propagated findings at unexpected nodes actionable', () => {
    const fastUriException = temporaryDirectExceptions.find(
      candidate => candidate.name === 'fast-uri',
    )!;
    const result = runAuditPolicy(
      completeVulnerabilityGraph({
        'fast-uri': exactDirectVulnerability(fastUriException),
        ajv: propagatedVulnerability(
          'ajv',
          'high',
          ['fast-uri'],
          'node_modules/parent/node_modules/ajv',
        ),
      }),
    );
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(
      output.ignored.map((entry: { name: string }) => entry.name),
    ).toContain('fast-uri');
    expect(
      output.actionable.map((entry: { name: string }) => entry.name),
    ).toContain('ajv');
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

    const result = runAuditPolicy(
      completeVulnerabilityGraph({ 'example-package': vulnerability }),
    );
    const output = parseStdout(result);

    expect(result.status).toBe(1);
    expect(output.actionable).toContainEqual({
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

  it('fails closed when metadata severity buckets contradict the records', () => {
    const vulnerabilities = currentVulnerabilityGraph();
    const result = runAuditReport({
      auditReportVersion: 2,
      vulnerabilities,
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 2,
          high: 8,
          critical: 0,
          total: 10,
        },
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'npm audit report is not a complete version 2 vulnerability report',
    );
  });

  it('fails closed for a malformed vulnerability entry', () => {
    const result = runAuditPolicy({
      ...currentVulnerabilityGraph(),
      'malformed-package': null,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'npm audit report is not a complete version 2 vulnerability report',
    );
  });

  it.each(['.github/workflows/ci-cd.yml', '.github/workflows/arcanos-release.yml'])(
    'records npm status but makes the fail-closed repository policy authoritative in %s',
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
    },
  );

  it('keeps a static near-term review deadline for the temporary exceptions', () => {
    const policy = readFileSync(auditPolicyScriptPath, 'utf8');

    expect(policy).toContain('Review no later than 2026-08-10');
    expect(policy).not.toContain('Date.now');
  });

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
