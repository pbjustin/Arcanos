import fs from 'node:fs';

const reportPath = process.argv[2];

if (!reportPath) {
  console.error('Usage: node scripts/check-npm-audit.js <audit-report.json>');
  process.exit(1);
}

const reportText = fs.readFileSync(reportPath, 'utf8').trim();
if (!reportText) {
  console.error('npm audit report is empty');
  process.exit(1);
}

const report = JSON.parse(reportText);
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
      vulnerabilityCounts.critical
) {
  console.error('npm audit report is not a complete version 2 vulnerability report');
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

const actionable = Object.entries(report.vulnerabilities).map(
  ([name, vulnerability]) => {
    const record =
      vulnerability && typeof vulnerability === 'object' && !Array.isArray(vulnerability)
        ? vulnerability
        : {};

    return {
      name,
      severity: record.severity ?? 'unknown',
      via: Array.isArray(record.via) ? record.via.map(projectViaEntry) : [],
      fixAvailable: record.fixAvailable ?? null,
      nodes: Array.isArray(record.nodes) ? record.nodes : [],
    };
  },
);

const output = {
  auditReportVersion: report.auditReportVersion,
  actionable,
};

console.log(JSON.stringify(output, null, 2));

if (actionable.length > 0) {
  process.exit(1);
}
