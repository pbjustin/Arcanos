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
const vulnerabilities = report.vulnerabilities ?? {};

const IGNORED_LODASH_SOURCES = new Set([1115806, 1115810]);
const IGNORED_LODASH_URLS = new Set([
  'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
  'https://github.com/advisories/GHSA-f23m-r3pf-42rh',
]);

function isIgnoredLodashAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'lodash') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_LODASH_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_LODASH_URLS.has(advisory.url);
}

function isIgnoredVulnerability(name, vulnerability) {
  if (!vulnerability || typeof vulnerability !== 'object') {
    return false;
  }

  const via = Array.isArray(vulnerability.via) ? vulnerability.via : [];

  if (name === 'lodash') {
    return via.length > 0 && via.every(isIgnoredLodashAdvisory);
  }

  if (name === 'knex') {
    return via.length > 0 && via.every(entry => entry === 'lodash');
  }

  return false;
}

const ignored = [];
const actionable = [];

for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (isIgnoredVulnerability(name, vulnerability)) {
    ignored.push({
      name,
      severity: vulnerability.severity ?? 'unknown',
      via: Array.isArray(vulnerability.via)
        ? vulnerability.via.map(entry => {
            if (typeof entry === 'string') {
              return entry;
            }

            return {
              name: entry.name ?? null,
              source: entry.source ?? null,
              url: entry.url ?? null,
            };
          })
        : [],
    });
    continue;
  }

  actionable.push({
    name,
    severity: vulnerability.severity ?? 'unknown',
    via: Array.isArray(vulnerability.via)
      ? vulnerability.via.map(entry => {
          if (typeof entry === 'string') {
            return entry;
          }

          return {
            name: entry.name ?? null,
            source: entry.source ?? null,
            url: entry.url ?? null,
          };
        })
      : [],
    fixAvailable: vulnerability.fixAvailable ?? null,
    nodes: Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [],
  });
}

const output = {
  auditReportVersion: report.auditReportVersion ?? null,
  ignored,
  actionable,
};

console.log(JSON.stringify(output, null, 2));

if (actionable.length > 0) {
  process.exit(1);
}
