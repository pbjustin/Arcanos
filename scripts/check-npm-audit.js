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

// Temporary exception register. Review by 2026-07-28, or immediately when a
// supported resolution becomes available.
// - axios: the ten advisories published 2026-07-20 require axios 1.18.0, which
//   is not yet published to npm. The affected GET wrappers set an own undefined
//   data field, and the other affected request modes are not used. Retest and
//   remove these entries as soon as the patched release is available.
// - lodash (Knex -> lodash): GHSA-r5fr-rjxr-66jc/CVE-2026-4800 and
//   GHSA-f23m-r3pf-42rh/CVE-2026-2950 require lodash 4.18.0, which npm marks as
//   a deprecated bad release. The affected template/unset gadgets are not used
//   by the repository's query stores. Retest the Knex stores when Knex adopts a
//   supported patched lodash release or npm publishes a non-deprecated patch.
// - brace-expansion (vendored minimatch -> brace-expansion): the patched
//   5.0.6/5.0.7 releases are not yet published to npm and exposure is
//   tooling-only. Retest and remove these entries when a patch is published.
// Advisory IDs for every exception are deliberately source-scoped below, and
// affected graphs are constrained where usage assumptions matter, so an
// unexpected advisory or dependency path remains actionable.
const IGNORED_AXIOS_SOURCES = new Set([
  1123882, 1123884, 1123885, 1123957, 1123959, 1123961, 1123967, 1123969, 1123971,
  1123973,
]);
const IGNORED_AXIOS_URLS = new Set([
  'https://github.com/advisories/GHSA-42h9-826w-cgv3',
  'https://github.com/advisories/GHSA-xj6q-8x83-jv6g',
  'https://github.com/advisories/GHSA-pmv8-rq9r-6j72',
  'https://github.com/advisories/GHSA-jqh4-m9w3-8hp9',
  'https://github.com/advisories/GHSA-mmx7-hfxf-jppx',
  'https://github.com/advisories/GHSA-f4gw-2p7v-4548',
  'https://github.com/advisories/GHSA-gcfj-64vw-6mp9',
  'https://github.com/advisories/GHSA-hcpx-6fm6-wx23',
  'https://github.com/advisories/GHSA-7q8q-rj6j-mhjq',
  'https://github.com/advisories/GHSA-mwf2-3pr3-8698',
]);
const IGNORED_AXIOS_NODES = new Set(['node_modules/axios']);
const IGNORED_LODASH_SOURCES = new Set([1115806, 1115810]);
const IGNORED_LODASH_URLS = new Set([
  'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
  'https://github.com/advisories/GHSA-f23m-r3pf-42rh',
]);
const IGNORED_BRACE_EXPANSION_SOURCES = new Set([1120311, 1123898]);
const IGNORED_BRACE_EXPANSION_URLS = new Set([
  'https://github.com/advisories/GHSA-jxxr-4gwj-5jf2',
  'https://github.com/advisories/GHSA-3jxr-9vmj-r5cp',
]);
const IGNORED_BRACE_EXPANSION_NODES = new Set([
  'vendor/minimatch-9.0.7/node_modules/brace-expansion',
]);

function isIgnoredAxiosAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'axios') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_AXIOS_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_AXIOS_URLS.has(advisory.url);
}

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

  if (name === 'axios') {
    const nodes = Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [];
    return (
      via.length > 0 &&
      via.every(isIgnoredAxiosAdvisory) &&
      nodes.length > 0 &&
      nodes.every(node => IGNORED_AXIOS_NODES.has(node))
    );
  }

  if (name === 'lodash') {
    return via.length > 0 && via.every(isIgnoredLodashAdvisory);
  }

  if (name === 'knex') {
    return via.length > 0 && via.every(entry => entry === 'lodash');
  }

  // These upstream advisories are source-scoped so new advisories or unrelated
  // transitive chains still fail the CI audit gate.
  if (name === 'brace-expansion') {
    const nodes = Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [];
    return (
      via.length > 0 &&
      via.every(isIgnoredBraceExpansionAdvisory) &&
      nodes.length > 0 &&
      nodes.every(node => IGNORED_BRACE_EXPANSION_NODES.has(node))
    );
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
