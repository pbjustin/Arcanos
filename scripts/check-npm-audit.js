import fs from 'node:fs';
import path from 'node:path';

// Temporary exceptions for advisories published on 2026-08-03 whose patched
// releases are not yet available from npm. Review no later than 2026-08-10 and
// remove each exception as soon as its patched release is published.
const temporaryDirectExceptions = {
  'brace-expansion': {
    severity: 'high',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-rgw5-rvv9-x895',
        severity: 'high',
      },
    ],
    identity: {
      node: 'vendor/minimatch-9.0.7/node_modules/brace-expansion',
      version: '5.0.8',
      resolved:
        'git+ssh://git@github.com/juliangruber/brace-expansion.git#96a63c0011c0288846ad41773c73e3fbd0906b59',
      integrity:
        'sha512-BgHSva7M0cHAkCKopVjMPI93ycF9FDOk/EFQQl4ZOOMOzddm0dQFnlX4jW87oVeQe+Dxef82XumA6NBSQxBdWA==',
    },
    fixAvailable: false,
  },
  'fast-uri': {
    severity: 'high',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-7p8r-x3mc-p8w7',
        severity: 'high',
      },
    ],
    identity: {
      node: 'node_modules/fast-uri',
      version: '3.1.4',
      resolved:
        'https://codeload.github.com/fastify/fast-uri/tar.gz/refs/tags/v3.1.4',
      integrity:
        'sha512-w1d9PDFY3xOqTzTD9Nmyyfv1WQJ8lGtAQMbKVwwmACHqYjK3Wfh+Ko1HLqarlQZQr5rKoaVz4MvHAIj33Qzw0A==',
    },
    fixAvailable: {
      name: 'ajv',
      version: '8.16.0',
      isSemVerMajor: true,
    },
  },
  hono: {
    severity: 'moderate',
    advisories: [
      {
        url: 'https://github.com/advisories/GHSA-8j4g-w8fx-2239',
        severity: 'moderate',
      },
    ],
    identity: {
      node: 'node_modules/hono',
      version: '4.12.32',
      resolved: 'https://registry.npmjs.org/hono/-/hono-4.12.32.tgz',
      integrity:
        'sha512-XcuyW9qE2kJn07PkecMOBd5Vq/hMy7mmGw+idz1yblbg9N17ijJODrvPkn7/dwL3Kulj8LcRJ69DLOWf91dRUg==',
    },
    fixAvailable: {
      name: '@modelcontextprotocol/sdk',
      version: '1.25.3',
      isSemVerMajor: true,
    },
  },
  'ip-address': {
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
    identity: {
      node: 'node_modules/ip-address',
      version: '10.1.1',
      resolved:
        'https://registry.npmjs.org/ip-address/-/ip-address-10.1.1.tgz',
      integrity:
        'sha512-1FMu8/N15Ck1BL551Jf42NYIoin2unWjLQ2Fze/DXryJRl5twqtwNHlO39qERGbIOcKYWHdgRryhOC+NG4eaLw==',
    },
    fixAvailable: true,
  },
  undici: {
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
    identity: {
      node: 'node_modules/undici',
      version: '7.28.0',
      resolved: 'https://registry.npmjs.org/undici/-/undici-7.28.0.tgz',
      integrity:
        'sha512-cRZYrTDwWznlnRiPjggAGxZXanty6M8RV1ff8Wm4LWXBp7/IG8v5DnOm74DtUBp9OONpK75YlPnIjQqX0dBDtA==',
    },
    fixAvailable: {
      name: 'cheerio',
      version: '1.0.0',
      isSemVerMajor: true,
    },
  },
};

const temporaryPropagatedExceptions = {
  '@hono/node-server': {
    severity: 'moderate',
    via: ['hono'],
    identity: {
      node: 'node_modules/@hono/node-server',
      version: '2.0.12',
      resolved:
        'https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.12.tgz',
      integrity:
        'sha512-eWpQYr67tqJLeaSUl0Q+TquuYfUdTibpOJlUMV2FfUP7+KqCC5TufnwnlXL6mobZBJbGAYRd7ZvEBDCbLInjhg==',
    },
    fixAvailable: {
      name: '@modelcontextprotocol/sdk',
      version: '1.25.3',
      isSemVerMajor: true,
    },
  },
  '@modelcontextprotocol/sdk': {
    severity: 'high',
    via: ['@hono/node-server', 'ajv', 'express-rate-limit', 'hono'],
    identity: {
      node: 'node_modules/@modelcontextprotocol/sdk',
      version: '1.30.0',
      resolved:
        'https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz',
      integrity:
        'sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==',
    },
    fixAvailable: {
      name: '@modelcontextprotocol/sdk',
      version: '1.25.3',
      isSemVerMajor: true,
    },
  },
  ajv: {
    severity: 'high',
    via: ['fast-uri'],
    identity: {
      node: 'node_modules/ajv',
      version: '8.18.0',
      resolved: 'https://registry.npmjs.org/ajv/-/ajv-8.18.0.tgz',
      integrity:
        'sha512-PlXPeEWMXMZ7sPYOHqmDyCJzcfNrUr3fGNKtezX14ykXOEIvyK81d+qydx89KY5O71FKMPaQ2vBfBFI5NHR63A==',
    },
    fixAvailable: {
      name: 'ajv',
      version: '8.16.0',
      isSemVerMajor: true,
    },
  },
  cheerio: {
    severity: 'moderate',
    via: ['undici'],
    identity: {
      node: 'node_modules/cheerio',
      version: '1.1.2',
      resolved:
        'https://registry.npmjs.org/cheerio/-/cheerio-1.1.2.tgz',
      integrity:
        'sha512-IkxPpb5rS/d1IiLbHMgfPuS0FgiWTtFIm/Nj+2woXDLTZ7fOT2eqzgYbdMlLweqlHbsZjxEChoVK+7iph7jyQg==',
    },
    fixAvailable: {
      name: 'cheerio',
      version: '1.0.0',
      isSemVerMajor: true,
    },
  },
  'express-rate-limit': {
    severity: 'high',
    via: ['ip-address'],
    identity: {
      node: 'node_modules/express-rate-limit',
      version: '8.3.0',
      resolved:
        'https://codeload.github.com/express-rate-limit/express-rate-limit/tar.gz/refs/tags/v8.3.0',
      integrity:
        'sha512-qWCW0wv8JTa9dqgeZCYUbnGbF8W/DXcKXhLuyl+NkxEjxfMWuGJVejPZiXg68o+pUOjixaCAuhJ9FqHSkbBYxg==',
    },
    fixAvailable: true,
  },
};

const vulnerabilitySeverities = new Set([
  'info',
  'low',
  'moderate',
  'high',
  'critical',
]);
const temporaryExceptionIdentities = [
  ...Object.values(temporaryDirectExceptions),
  ...Object.values(temporaryPropagatedExceptions),
].map(exception => exception.identity);
// npm 10.8.2 on the Linux CI runner omits the propagated root cheerio record
// while retaining its exact direct undici advisory. npm 10 on Windows reports
// cheerio, and npm 11 additionally reports the vendored brace-expansion node.
// When either optional record is present it must still match its full exception.
const platformOptionalTemporaryExceptionNames = new Set([
  'brace-expansion',
  'cheerio',
]);
const requiredTemporaryExceptionNames = new Set([
  ...Object.keys(temporaryDirectExceptions),
  ...Object.keys(temporaryPropagatedExceptions),
].filter(name => !platformOptionalTemporaryExceptionNames.has(name)));

const reportPath = process.argv[2];
const candidateLockPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(process.cwd(), 'package-lock.json');

if (!reportPath) {
  console.error(
    'Usage: node scripts/check-npm-audit.js <audit-report.json> [package-lock.json]',
  );
  process.exit(1);
}

const reportText = fs.readFileSync(reportPath, 'utf8').trim();
if (!reportText) {
  console.error('npm audit report is empty');
  process.exit(1);
}

let report;
try {
  report = JSON.parse(reportText);
} catch {
  console.error('npm audit report is not valid JSON');
  process.exit(1);
}

let candidateLock;
try {
  const candidateLockText = fs.readFileSync(candidateLockPath, 'utf8').trim();
  if (!candidateLockText) {
    throw new Error('empty candidate lock');
  }
  candidateLock = JSON.parse(candidateLockText);
} catch {
  console.error('candidate package-lock.json is missing or malformed');
  process.exit(1);
}

if (
  !isRecord(candidateLock) ||
  candidateLock.lockfileVersion !== 3 ||
  !isRecord(candidateLock.packages) ||
  !temporaryExceptionIdentities.every(identity =>
    hasExactLockIdentity(candidateLock, identity),
  )
) {
  console.error(
    'candidate package-lock.json does not match temporary audit exception identities',
  );
  process.exit(1);
}
const vulnerabilityCountKeys = [
  'info',
  'low',
  'moderate',
  'high',
  'critical',
  'total',
];
const vulnerabilityCounts = report?.metadata?.vulnerabilities;
const hasCompleteVulnerabilityCounts =
  vulnerabilityCounts &&
  typeof vulnerabilityCounts === 'object' &&
  !Array.isArray(vulnerabilityCounts) &&
  vulnerabilityCountKeys.every(
    key =>
      Number.isInteger(vulnerabilityCounts[key]) &&
      vulnerabilityCounts[key] >= 0,
  );

const vulnerabilityRecords =
  report?.vulnerabilities &&
  typeof report.vulnerabilities === 'object' &&
  !Array.isArray(report.vulnerabilities)
    ? Object.values(report.vulnerabilities)
    : [];
const actualVulnerabilityCounts = {
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
};
const hasRecognizedVulnerabilitySeverities = vulnerabilityRecords.every(
  vulnerability => {
    if (
      !isRecord(vulnerability) ||
      !vulnerabilitySeverities.has(vulnerability.severity)
    ) {
      return false;
    }

    actualVulnerabilityCounts[vulnerability.severity] += 1;
    return true;
  },
);
const hasMatchingVulnerabilityCounts =
  hasCompleteVulnerabilityCounts &&
  hasRecognizedVulnerabilitySeverities &&
  [...vulnerabilitySeverities].every(
    severity =>
      vulnerabilityCounts[severity] === actualVulnerabilityCounts[severity],
  );

if (
  !report ||
  typeof report !== 'object' ||
  Array.isArray(report) ||
  report.auditReportVersion !== 2 ||
  !report.vulnerabilities ||
  typeof report.vulnerabilities !== 'object' ||
  Array.isArray(report.vulnerabilities) ||
  !hasCompleteVulnerabilityCounts ||
  vulnerabilityCounts.total !== Object.keys(report.vulnerabilities).length ||
  vulnerabilityCounts.total !==
    vulnerabilityCounts.info +
      vulnerabilityCounts.low +
      vulnerabilityCounts.moderate +
      vulnerabilityCounts.high +
      vulnerabilityCounts.critical ||
  !hasMatchingVulnerabilityCounts
) {
  console.error('npm audit report is not a complete version 2 vulnerability report');
  process.exit(1);
}

const missingRequiredTemporaryExceptions = [
  ...requiredTemporaryExceptionNames,
].filter(name => !Object.hasOwn(report.vulnerabilities, name));
if (missingRequiredTemporaryExceptions.length > 0) {
  console.error(
    `npm audit report is missing required temporary advisory records: ${missingRequiredTemporaryExceptions.join(', ')}`,
  );
  process.exit(1);
}

function projectViaEntry(entry) {
  if (typeof entry === 'string') {
    return entry;
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      name: null,
      source: null,
      url: null,
    };
  }

  return {
    name: entry.name ?? null,
    source: entry.source ?? null,
    url: entry.url ?? null,
  };
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactLockIdentity(candidateLock, identity) {
  const lockedNode = candidateLock.packages[identity.node];
  return (
    isRecord(lockedNode) &&
    lockedNode.version === identity.version &&
    lockedNode.resolved === identity.resolved &&
    lockedNode.integrity === identity.integrity
  );
}

function hasExactNodes(record, expectedNodes) {
  return (
    Array.isArray(record.nodes) &&
    record.nodes.length === expectedNodes.length &&
    new Set(record.nodes).size === record.nodes.length &&
    record.nodes.every(
      node => typeof node === 'string' && expectedNodes.includes(node),
    )
  );
}

function hasExactFixAvailable(actual, expected) {
  if (typeof expected === 'boolean') {
    return actual === expected;
  }

  if (!isRecord(actual) || !isRecord(expected)) {
    return false;
  }

  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every(key => actual[key] === expected[key])
  );
}

function hasValidCommonShape(
  name,
  record,
  expectedNodes,
  expectedFixAvailable,
  expectedSeverity,
) {
  return (
    isRecord(record) &&
    record.name === name &&
    record.severity === expectedSeverity &&
    Array.isArray(record.via) &&
    record.via.length > 0 &&
    hasExactNodes(record, expectedNodes) &&
    hasExactFixAvailable(record.fixAvailable, expectedFixAvailable)
  );
}

function isIgnoredDirectVulnerability(name, vulnerability) {
  const exception = temporaryDirectExceptions[name];
  if (
    !exception ||
    !hasValidCommonShape(
      name,
      vulnerability,
      [exception.identity.node],
      exception.fixAvailable,
      exception.severity,
    )
  ) {
    return false;
  }

  const advisoryUrls = new Set();
  for (const entry of vulnerability.via) {
    const expectedAdvisory = isRecord(entry)
      ? exception.advisories.find(advisory => advisory.url === entry.url)
      : undefined;
    if (
      !isRecord(entry) ||
      entry.name !== name ||
      entry.dependency !== name ||
      !Number.isInteger(entry.source) ||
      entry.source <= 0 ||
      typeof entry.url !== 'string' ||
      !expectedAdvisory ||
      entry.severity !== expectedAdvisory.severity ||
      advisoryUrls.has(entry.url)
    ) {
      return false;
    }

    advisoryUrls.add(entry.url);
  }

  return advisoryUrls.size === exception.advisories.length;
}

function isIgnoredPropagatedVulnerability(
  name,
  vulnerability,
  ignoredNames,
) {
  const exception = temporaryPropagatedExceptions[name];
  if (
    !exception ||
    !hasValidCommonShape(
      name,
      vulnerability,
      [exception.identity.node],
      exception.fixAvailable,
      exception.severity,
    )
  ) {
    return false;
  }

  return (
    vulnerability.via.length === exception.via.length &&
    new Set(vulnerability.via).size === exception.via.length &&
    vulnerability.via.every(
      entry =>
        typeof entry === 'string' &&
        exception.via.includes(entry) &&
        ignoredNames.has(entry),
    )
  );
}

function projectVulnerability(name, vulnerability) {
  const record = isRecord(vulnerability) ? vulnerability : {};

  return {
    name,
    severity: record.severity ?? 'unknown',
    via: Array.isArray(record.via) ? record.via.map(projectViaEntry) : [],
    fixAvailable: record.fixAvailable ?? null,
    nodes: Array.isArray(record.nodes) ? record.nodes : [],
  };
}

const vulnerabilityEntries = Object.entries(report.vulnerabilities);
const ignoredNames = new Set(
  vulnerabilityEntries
    .filter(([name, vulnerability]) =>
      isIgnoredDirectVulnerability(name, vulnerability),
    )
    .map(([name]) => name),
);

let addedPropagatedException = true;
while (addedPropagatedException) {
  addedPropagatedException = false;

  for (const [name, vulnerability] of vulnerabilityEntries) {
    if (
      !ignoredNames.has(name) &&
      isIgnoredPropagatedVulnerability(name, vulnerability, ignoredNames)
    ) {
      ignoredNames.add(name);
      addedPropagatedException = true;
    }
  }
}

const ignored = [];
const actionable = [];
for (const [name, vulnerability] of vulnerabilityEntries) {
  const projected = projectVulnerability(name, vulnerability);
  if (ignoredNames.has(name)) {
    ignored.push(projected);
  } else {
    actionable.push(projected);
  }
}

const output = {
  auditReportVersion: report.auditReportVersion,
  ignored,
  actionable,
};

console.log(JSON.stringify(output, null, 2));

if (actionable.length > 0) {
  process.exit(1);
}
