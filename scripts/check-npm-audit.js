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

// Temporary exception register. Review by 2026-10-01, or immediately when the
// configured registry publishes a patched artifact or an owning parent release.
// - lodash (Knex -> lodash): patched 4.18.0 is unpublished; affected template/
//   unset gadgets are not used by the repository's query stores. Retest Knex
//   stores when a registry artifact or Knex parent fix is available.
// - follow-redirects/axios/form-data: patched artifacts are unpublished. The
//   caller-controlled fetch path disables redirects and proxying and does not
//   construct multipart bodies. Re-run network regression tests on publication.
// - @modelcontextprotocol/sdk: the server exposes no resource templates and
//   creates a fresh HTTP server/transport pair per request. Review on SDK update.
// - brace-expansion (vendored minimatch -> brace-expansion): remediation needs
//   the separately reviewed vendor/postinstall redesign; exposure is tooling-only.
// - fast-uri (Ajv -> fast-uri): schemas are repository-owned, not request-supplied.
// - hono (@modelcontextprotocol/sdk -> hono): no direct Hono API use was found.
// - undici (Cheerio -> undici): callers use Cheerio.load, not Cheerio.fromURL.
// - ws (root/workers/OpenAI -> ws): setupBridgeSocket has no live caller and
//   workers do not import ws. Review before activating that latent entry point.
// Advisory IDs for every exception are deliberately source-scoped below so an
// unexpected advisory for the same package remains actionable.
const IGNORED_LODASH_SOURCES = new Set([1115806, 1115810]);
const IGNORED_LODASH_URLS = new Set([
  'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
  'https://github.com/advisories/GHSA-f23m-r3pf-42rh',
]);
const IGNORED_FOLLOW_REDIRECTS_SOURCES = new Set([1116560]);
const IGNORED_FOLLOW_REDIRECTS_URLS = new Set([
  'https://github.com/advisories/GHSA-r4q5-vmmm-2653',
]);
const IGNORED_AXIOS_SOURCES = new Set([
  1119667,
  1120547,
  1120643,
  1120645,
  1120647,
  1120650,
  1120652,
  1120653,
]);
const IGNORED_AXIOS_URLS = new Set([
  'https://github.com/advisories/GHSA-pjwm-pj3p-43mv',
  'https://github.com/advisories/GHSA-hfxv-24rg-xrqf',
  'https://github.com/advisories/GHSA-777c-7fjr-54vf',
  'https://github.com/advisories/GHSA-p92q-9vqr-4j8v',
  'https://github.com/advisories/GHSA-j5f8-grm9-p9fc',
  'https://github.com/advisories/GHSA-35jp-ww65-95wh',
  'https://github.com/advisories/GHSA-898c-q2cr-xwhg',
  'https://github.com/advisories/GHSA-654m-c8p4-x5fp',
]);
const IGNORED_FORM_DATA_SOURCES = new Set([1120743]);
const IGNORED_FORM_DATA_URLS = new Set([
  'https://github.com/advisories/GHSA-hmw2-7cc7-3qxx',
]);
const IGNORED_MCP_SDK_SOURCES = new Set([1111906, 1113080]);
const IGNORED_MCP_SDK_URLS = new Set([
  'https://github.com/advisories/GHSA-8r9q-7v3j-jr4g',
  'https://github.com/advisories/GHSA-345p-7cg4-v4c7',
]);
const IGNORED_BRACE_EXPANSION_SOURCES = new Set([1119088]);
const IGNORED_BRACE_EXPANSION_URLS = new Set([
  'https://github.com/advisories/GHSA-jxxr-4gwj-5jf2',
]);
const IGNORED_FAST_URI_SOURCES = new Set([1117870, 1117884]);
const IGNORED_FAST_URI_URLS = new Set([
  'https://github.com/advisories/GHSA-q3j6-qgpj-74h6',
  'https://github.com/advisories/GHSA-v39h-62p7-jpjc',
]);
const IGNORED_HONO_SOURCES = new Set([
  1117915,
  1118963,
  1118964,
  1120082,
  1120083,
  1120084,
  1120085,
  1120910,
  1120911,
  1120913,
  1120921,
  1120922,
]);
const IGNORED_HONO_URLS = new Set([
  'https://github.com/advisories/GHSA-qp7p-654g-cw7p',
  'https://github.com/advisories/GHSA-hm8q-7f3q-5f36',
  'https://github.com/advisories/GHSA-p77w-8qqv-26rm',
  'https://github.com/advisories/GHSA-xrhx-7g5j-rcj5',
  'https://github.com/advisories/GHSA-3hrh-pfw6-9m5x',
  'https://github.com/advisories/GHSA-f577-qrjj-4474',
  'https://github.com/advisories/GHSA-2gcr-mfcq-wcc3',
  'https://github.com/advisories/GHSA-wwfh-h76j-fc44',
  'https://github.com/advisories/GHSA-j6c9-x7qj-28xf',
  'https://github.com/advisories/GHSA-88fw-hqm2-52qc',
  'https://github.com/advisories/GHSA-rv63-4mwf-qqc2',
  'https://github.com/advisories/GHSA-wgpf-jwqj-8h8p',
]);
const IGNORED_UNDICI_SOURCES = new Set([
  1121187,
  1121241,
  1121244,
  1121247,
  1121249,
  1121254,
  1121428,
]);
const IGNORED_UNDICI_URLS = new Set([
  'https://github.com/advisories/GHSA-vmh5-mc38-953g',
  'https://github.com/advisories/GHSA-p88m-4jfj-68fv',
  'https://github.com/advisories/GHSA-vxpw-j846-p89q',
  'https://github.com/advisories/GHSA-hm92-r4w5-c3mj',
  'https://github.com/advisories/GHSA-35p6-xmwp-9g52',
  'https://github.com/advisories/GHSA-g8m3-5g58-fq7m',
  'https://github.com/advisories/GHSA-pr7r-676h-xcf6',
]);
const IGNORED_WS_SOURCES = new Set([1119108, 1120730]);
const IGNORED_WS_URLS = new Set([
  'https://github.com/advisories/GHSA-58qx-3vcg-4xpx',
  'https://github.com/advisories/GHSA-96hv-2xvq-fx4p',
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

function isIgnoredFormDataAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'form-data') {
    return false;
  }

  if (
    typeof advisory.source === 'number' &&
    IGNORED_FORM_DATA_SOURCES.has(advisory.source)
  ) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_FORM_DATA_URLS.has(advisory.url);
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

function isIgnoredFastUriAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'fast-uri') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_FAST_URI_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_FAST_URI_URLS.has(advisory.url);
}

function isIgnoredHonoAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'hono') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_HONO_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_HONO_URLS.has(advisory.url);
}

function isIgnoredUndiciAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'undici') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_UNDICI_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_UNDICI_URLS.has(advisory.url);
}

function isIgnoredWsAdvisory(advisory) {
  if (!advisory || typeof advisory !== 'object') {
    return false;
  }

  if (advisory.name !== 'ws') {
    return false;
  }

  if (typeof advisory.source === 'number' && IGNORED_WS_SOURCES.has(advisory.source)) {
    return true;
  }

  return typeof advisory.url === 'string' && IGNORED_WS_URLS.has(advisory.url);
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

  if (name === 'axios') {
    return (
      via.length > 0 &&
      via.every(entry => entry === 'form-data' || isIgnoredAxiosAdvisory(entry))
    );
  }

  if (name === 'form-data') {
    return via.length > 0 && via.every(isIgnoredFormDataAdvisory);
  }

  if (name === '@modelcontextprotocol/sdk') {
    // GHSA-8r9q-7v3j-jr4g applies to resource template handling with exploded
    // array patterns; this server exposes tools only and does not register MCP
    // resources or resource templates. GHSA-345p-7cg4-v4c7 applies when a
    // server/transport pair is reused across clients; our HTTP MCP route
    // constructs a fresh server and transport for every request.
    return (
      via.length > 0 &&
      via.every(
        entry => entry === 'express' || entry === 'hono' || isIgnoredMcpSdkAdvisory(entry),
      )
    );
  }

  // These upstream advisories are source-scoped so new advisories or unrelated
  // transitive chains still fail the CI audit gate.
  if (name === 'brace-expansion') {
    return via.length > 0 && via.every(isIgnoredBraceExpansionAdvisory);
  }

  if (name === 'fast-uri') {
    return via.length > 0 && via.every(isIgnoredFastUriAdvisory);
  }

  if (name === 'hono') {
    return via.length > 0 && via.every(isIgnoredHonoAdvisory);
  }

  if (name === 'undici') {
    return via.length > 0 && via.every(isIgnoredUndiciAdvisory);
  }

  if (name === 'cheerio') {
    return via.length > 0 && via.every(entry => entry === 'undici');
  }

  if (name === 'ws') {
    return via.length > 0 && via.every(isIgnoredWsAdvisory);
  }

  if (name === '@hono/node-server') {
    return via.length > 0 && via.every(entry => entry === 'hono');
  }

  if (name === 'openai') {
    return via.length > 0 && via.every(entry => entry === 'ws');
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
