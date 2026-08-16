import fs from 'node:fs';

const vulnerabilitySeverities = [
  'info',
  'low',
  'moderate',
  'high',
  'critical',
];
const vulnerabilitySeveritySet = new Set(vulnerabilitySeverities);
const vulnerabilityCountKeys = [...vulnerabilitySeverities, 'total'];
const reportPath = process.argv[2];

if (!reportPath) {
  fail('Usage: node scripts/check-npm-audit.js <audit-report.json>');
}

let reportText;
try {
  reportText = fs.readFileSync(reportPath, 'utf8').trim();
} catch {
  fail('npm audit report is missing or unreadable');
}

if (!reportText) {
  fail('npm audit report is empty');
}

let report;
try {
  report = JSON.parse(reportText);
} catch {
  fail('npm audit report is not valid JSON');
}

if (!isCompleteVersionTwoReport(report)) {
  fail('npm audit report is not a complete version 2 vulnerability report');
}

const actionable = Object.entries(report.vulnerabilities).map(
  ([name, vulnerability]) => projectVulnerability(name, vulnerability),
);

console.log(
  JSON.stringify(
    {
      auditReportVersion: report.auditReportVersion,
      ignored: [],
      actionable,
    },
    null,
    2,
  ),
);

if (actionable.length > 0) {
  process.exitCode = 1;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCompleteVersionTwoReport(candidate) {
  if (
    !isRecord(candidate) ||
    candidate.auditReportVersion !== 2 ||
    !isRecord(candidate.vulnerabilities) ||
    !isRecord(candidate.metadata) ||
    !isRecord(candidate.metadata.vulnerabilities)
  ) {
    return false;
  }

  const vulnerabilityEntries = Object.entries(candidate.vulnerabilities);
  const reportedCounts = candidate.metadata.vulnerabilities;
  if (
    !vulnerabilityCountKeys.every(
      key => Number.isInteger(reportedCounts[key]) && reportedCounts[key] >= 0,
    ) ||
    reportedCounts.total !== vulnerabilityEntries.length ||
    reportedCounts.total !==
      vulnerabilitySeverities.reduce(
        (total, severity) => total + reportedCounts[severity],
        0,
      )
  ) {
    return false;
  }

  const actualCounts = Object.fromEntries(
    vulnerabilitySeverities.map(severity => [severity, 0]),
  );
  for (const [, vulnerability] of vulnerabilityEntries) {
    if (
      !isRecord(vulnerability) ||
      !vulnerabilitySeveritySet.has(vulnerability.severity)
    ) {
      return false;
    }
    actualCounts[vulnerability.severity] += 1;
  }

  return vulnerabilitySeverities.every(
    severity => reportedCounts[severity] === actualCounts[severity],
  );
}

function projectViaEntry(entry) {
  if (typeof entry === 'string') {
    return entry;
  }

  if (!isRecord(entry)) {
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

function projectVulnerability(name, vulnerability) {
  return {
    name,
    severity: vulnerability.severity,
    via: Array.isArray(vulnerability.via)
      ? vulnerability.via.map(projectViaEntry)
      : [],
    fixAvailable: vulnerability.fixAvailable ?? null,
    nodes: Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [],
  };
}
