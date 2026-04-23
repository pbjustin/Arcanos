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
const IGNORED_FOLLOW_REDIRECTS_SOURCES = new Set([1116560]);
const IGNORED_FOLLOW_REDIRECTS_URLS = new Set([
  'https://github.com/advisories/GHSA-r4q5-vmmm-2653',
]);
const IGNORED_MCP_SDK_SOURCES = new Set([1111906, 1113080]);
const IGNORED_MCP_SDK_URLS = new Set([
  'https://github.com/advisories/GHSA-8r9q-7v3j-jr4g',
  'https://github.com/advisories/GHSA-345p-7cg4-v4c7',
]);
const IGNORED_UUID_SOURCES = new Set([1116970]);
const IGNORED_UUID_URLS = new Set([
  'https://github.com/advisories/GHSA-w5hq-g745-h8pq',
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

function isIgnoredFollowRedirectsAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'follow-redirects') {
    return false;
  }

  if (
    typeof advisory.source === 'number' &&
    IGNORED_FOLLOW_REDIRECTS_SOURCES.has(advisory.source)
  ) {
    return true;
  }

  return (
    typeof advisory.url === 'string' && IGNORED_FOLLOW_REDIRECTS_URLS.has(advisory.url)
  );
}

function isIgnoredMcpSdkAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== '@modelcontextprotocol/sdk') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_MCP_SDK_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_MCP_SDK_URLS.has(advisory.url);
}

function isIgnoredUuidAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'uuid') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_UUID_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_UUID_URLS.has(advisory.url);
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

  if (name === 'follow-redirects') {
    return via.length > 0 && via.every(isIgnoredFollowRedirectsAdvisory);
  }

  if (name === '@modelcontextprotocol/sdk') {
    // GHSA-8r9q-7v3j-jr4g applies to resource template handling with exploded
    // array patterns; this server exposes tools only and does not register MCP
    // resources or resource templates. GHSA-345p-7cg4-v4c7 applies when a
    // server/transport pair is reused across clients; our HTTP MCP route
    // constructs a fresh server and transport for every request.
    return via.length > 0 && via.every(isIgnoredMcpSdkAdvisory);
  }

  if (name === 'uuid') {
    // GHSA-w5hq-g745-h8pq applies to uuid v3/v5/v6 when callers provide a buf
    // argument. uuid@14.0.0 is the audit-reported fixed version but is not
    // published yet; this service does not call uuid directly, and BullMQ's
    // bundled usage is limited to v4() for queue/worker ids.
    return via.length > 0 && via.every(isIgnoredUuidAdvisory);
  }

  if (name === 'bullmq') {
    return via.length > 0 && via.every(entry => entry === 'uuid');
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
