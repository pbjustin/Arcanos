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

// Temporary exception register. Review by 2026-10-01, or immediately when an
// owning parent publishes a supported resolution.
// - lodash (Knex -> lodash): GHSA-r5fr-rjxr-66jc/CVE-2026-4800 and
//   GHSA-f23m-r3pf-42rh/CVE-2026-2950 require lodash 4.18.0, which npm marks as
//   a deprecated bad release. The affected template/unset gadgets are not used
//   by the repository's query stores. Retest the Knex stores when Knex adopts a
//   supported patched lodash release or npm publishes a non-deprecated patch.
// - brace-expansion (vendored minimatch -> brace-expansion): GHSA-jxxr-4gwj-5jf2
//   remediation needs the separately reviewed vendor/postinstall redesign;
//   exposure is tooling-only. Review when that architecture is replaced.
// Advisory IDs for every exception are deliberately source-scoped below so an
// unexpected advisory for the same package remains actionable.
const IGNORED_LODASH_SOURCES = new Set([1115806, 1115810]);
const IGNORED_LODASH_URLS = new Set([
  'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
  'https://github.com/advisories/GHSA-f23m-r3pf-42rh',
]);
const IGNORED_BRACE_EXPANSION_SOURCES = new Set([1119088]);
const IGNORED_BRACE_EXPANSION_URLS = new Set([
  'https://github.com/advisories/GHSA-jxxr-4gwj-5jf2',
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

function isIgnoredBraceExpansionAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'brace-expansion') {
    return false;
  }

  if (
    typeof advisory.source === 'number' &&
    IGNORED_BRACE_EXPANSION_SOURCES.has(advisory.source)
  ) {
    return true;
  }

  return (
    typeof advisory.url === 'string' && IGNORED_BRACE_EXPANSION_URLS.has(advisory.url)
  );
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

  // These upstream advisories are source-scoped so new advisories or unrelated
  // transitive chains still fail the CI audit gate.
  if (name === 'brace-expansion') {
    return via.length > 0 && via.every(isIgnoredBraceExpansionAdvisory);
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
