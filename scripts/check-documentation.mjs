#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const repositoryRoot = process.cwd();
const checks = [];

function record(description, passed, detail = '') {
  checks.push({ description, passed, detail });
  const prefix = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`${prefix}: ${description}${detail ? `\n  ${detail}` : ''}\n`);
}

function trackedFiles(pathspec) {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--', pathspec],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ls-files failed for ${pathspec}`);
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .filter((relativePath) => existsSync(resolve(repositoryRoot, relativePath)));
}

function read(relativePath) {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

function markdownLinkTarget(rawTarget) {
  const trimmed = rawTarget.trim();
  if (trimmed.startsWith('<')) {
    const closing = trimmed.indexOf('>');
    return closing >= 0 ? trimmed.slice(1, closing) : trimmed.slice(1);
  }

  return trimmed.split(/\s+["']/u, 1)[0];
}

function isExternalOrRoute(target) {
  return (
    target.startsWith('#')
    || target.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/iu.test(target)
  );
}

function targetWithoutSuffix(target) {
  const hashIndex = target.indexOf('#');
  const queryIndex = target.indexOf('?');
  const suffixIndexes = [hashIndex, queryIndex].filter((value) => value >= 0);
  const end = suffixIndexes.length > 0 ? Math.min(...suffixIndexes) : target.length;
  const withoutSuffix = target.slice(0, end);

  try {
    return decodeURIComponent(withoutSuffix);
  } catch {
    return withoutSuffix;
  }
}

process.stdout.write('Arcanos documentation audit\n');

const requiredFiles = [
  'README.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'DEPRECATION.md',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/PULL_REQUEST_TEMPLATE/hotfix.md',
  'docs/README.md',
  'docs/DOCUMENTATION.md',
  'docs/ARCHITECTURE.md',
  'docs/CONFIGURATION.md',
  'docs/API.md',
  'docs/RUN_LOCAL.md',
  'docs/RAILWAY_DEPLOYMENT.md',
  'docs/TROUBLESHOOTING.md',
  'docs/CI_CD.md',
];

for (const relativePath of requiredFiles) {
  record(`${relativePath} exists`, existsSync(resolve(repositoryRoot, relativePath)));
}

const retiredDocuments = [
  'QUICKSTART.md',
  'CODEBASE_INDEX.md',
  'OPENAI_ADAPTER_MIGRATION.md',
  'RAILWAY_COMPATIBILITY_GUIDE.md',
  'docs/CLI_CONSOLIDATION.md',
  'docs/CLI_DAEMON.md',
  'docs/ASYNC_GPT_JOB_BOARD_BACKEND_SPEC.md',
  'docs/OPERATIONS_DASHBOARD.md',
  'docs/OPERATOR_DISPATCHER.md',
  'docs/REFACTOR_MONOREPO.md',
  'docs/REFACTOR_OPENAI_SHARED_ADAPTERS.md',
  'docs/REFACTOR_RUNTIME_LAYER.md',
  'docs/refactor-audit.md',
  'docs/REFERENCES.md',
  'daemon-python/CLI_MODULE_CONTRACTS.md',
  'daemon-python/DEBUG_SERVER_README.md',
  'daemon-python/arcanos/assets/README.md',
  'scripts/daemon-install-staging/assets/README.md',
  'governance/branch_protection.md',
  'governance/rollback_rules.md',
  'governance/versioning.md',
  'governance/self-reflection-tests/self-reflection-pr-test-2026-03-05T08-14-12-497Z.md',
];

for (const relativePath of retiredDocuments) {
  record(
    `${relativePath} remains consolidated`,
    !existsSync(resolve(repositoryRoot, relativePath)),
  );
}

const retiredReferenceTerms = retiredDocuments.map((relativePath) => {
  const basename = relativePath.split('/').at(-1);
  return basename === 'README.md'
    || basename === 'versioning.md'
    || relativePath === 'docs/refactor-audit.md'
    ? relativePath
    : basename;
});

for (const term of new Set(retiredReferenceTerms)) {
  const result = spawnSync(
    'git',
    [
      'grep',
      '-n',
      '-F',
      '--',
      term,
      '--',
      ':!scripts/check-documentation.mjs',
      ':!docs/audits/**',
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  const matches = result.status === 0 ? result.stdout.trim() : '';
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || `git grep failed for ${term}`);
  }
  record(
    `No active references to retired document: ${term}`,
    matches.length === 0,
    matches,
  );
}

const markdownFiles = trackedFiles('*.md');
const activeMarkdownFiles = markdownFiles.filter(
  (relativePath) => !relativePath.startsWith('docs/audits/'),
);

for (const relativePath of markdownFiles) {
  const source = read(relativePath);
  const sourceForLinks = source
    .replace(/```[\s\S]*?```/gu, '')
    .replace(/`[^`\r\n]*`/gu, '');
  const inlineLinkPattern = /!?\[[^\]]*\]\(([^)\r\n]+)\)/gu;
  const referenceLinkPattern = /^\s*\[[^\]]+\]:\s*(\S+)/gmu;
  const candidates = [];

  for (const match of sourceForLinks.matchAll(inlineLinkPattern)) {
    candidates.push(markdownLinkTarget(match[1]));
  }
  for (const match of sourceForLinks.matchAll(referenceLinkPattern)) {
    candidates.push(markdownLinkTarget(match[1]));
  }

  for (const target of candidates) {
    if (!target || isExternalOrRoute(target)) {
      continue;
    }

    const localTarget = targetWithoutSuffix(target);
    if (!localTarget) {
      continue;
    }

    const resolvedTarget = normalize(
      resolve(repositoryRoot, dirname(relativePath), localTarget),
    );
    record(
      `${relativePath} link target exists: ${target}`,
      existsSync(resolvedTarget),
      existsSync(resolvedTarget) ? '' : resolvedTarget,
    );
  }
}

const activeMarkdown = activeMarkdownFiles
  .map((relativePath) => `${relativePath}\n${read(relativePath)}`)
  .join('\n');

const stalePatterns = [
  ['legacy OpenAI SDK v5.16.0 wording', /v5\.16\.0/u],
  ['obsolete X-Confirmation header wording', /X-Confirmation/u],
  ['stale docs/api path', /docs\/api\//u],
  ['stale docs/deployment path', /docs\/deployment\//u],
  ['stale docs/ai-guides path', /docs\/ai-guides\//u],
];

for (const [description, pattern] of stalePatterns) {
  record(`No ${description}`, !pattern.test(activeMarkdown));
}

const unsafeProbeReferences = activeMarkdownFiles.flatMap((relativePath) => (
  read(relativePath)
    .split(/\r?\n/u)
    .filter((line) => (
      /npm run probe/u.test(line)
      && !/\b(?:do not|never|must not|forbidden|unsafe)\b/iu.test(line)
    ))
    .map((line) => `${relativePath}: ${line.trim()}`)
));
record(
  'Active documentation does not recommend npm run probe',
  unsafeProbeReferences.length === 0,
  unsafeProbeReferences.join(', '),
);

const documentationIndex = read('docs/README.md');
const documentationIndexLinks = new Set();
const documentationIndexLinkPattern = /!?\[[^\]]*\]\(([^)\r\n]+)\)/gu;

for (const match of documentationIndex.matchAll(documentationIndexLinkPattern)) {
  const target = markdownLinkTarget(match[1]);
  if (!target || isExternalOrRoute(target)) {
    continue;
  }

  const localTarget = targetWithoutSuffix(target);
  if (localTarget) {
    documentationIndexLinks.add(
      normalize(resolve(repositoryRoot, 'docs', localTarget)),
    );
  }
}

const topLevelDocs = markdownFiles.filter(
  (relativePath) => /^docs\/[^/]+\.md$/u.test(relativePath)
    && relativePath !== 'docs/README.md',
);

for (const relativePath of topLevelDocs) {
  const basename = relativePath.slice('docs/'.length);
  record(
    `docs/README.md indexes ${basename}`,
    documentationIndexLinks.has(resolve(repositoryRoot, relativePath)),
  );
}

const passed = checks.filter((check) => check.passed).length;
const failed = checks.length - passed;

process.stdout.write('\n');
process.stdout.write(`Total Checks: ${checks.length}\n`);
process.stdout.write(`Passed: ${passed}\n`);
process.stdout.write(`Failed: ${failed}\n`);
process.stdout.write('Warnings: 0\n');
process.stdout.write(
  failed === 0
    ? 'Documentation audit passed\n'
    : 'Documentation audit failed\n',
);

process.exit(failed === 0 ? 0 : 1);
