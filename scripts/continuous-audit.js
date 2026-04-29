#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const EXCLUDED_DIRS = new Set([
  '.git',
  '.pytest_cache',
  '__pycache__',
  'coverage',
  'dist',
  'node_modules',
  'tmp'
]);
const SCAN_ROOTS = [
  'src',
  'packages',
  'workers',
  'arcanos-ai-runtime',
  'daemon-python',
  'scripts'
];
const SELF_FILE = normalizeRelativePath(path.join('scripts', 'continuous-audit.js'));
const OPENAI_CONSTRUCTOR_ALLOWLIST = new Set([
  normalizeRelativePath(path.join('packages', 'arcanos-openai', 'src', 'client.ts')),
  normalizeRelativePath(path.join('src', 'core', 'adapters', 'openai.adapter.ts'))
]);
const KNOWN_OPENAI_MIGRATION_SCRIPTS = new Set([
  normalizeRelativePath(path.join('scripts', 'assistants-sync.ts')),
  normalizeRelativePath(path.join('scripts', 'compare-finetune-checkpoints.ts')),
  normalizeRelativePath(path.join('scripts', 'migration-repair.js'))
]);
const KNOWN_OPENAI_MIGRATION_EXCEPTION = {
  policy: 'known_migration_deprecation',
  deprecationLedgerEntry: 'Raw OpenAI SDK construction in scripts',
  blocking: false,
  reason: 'Tracked as later-work adapter migration; finding must remain visible until migrated.'
};
const SCRIPT_TARGET_CLASSIFICATIONS = new Map([
  [
    'db:init|scripts/db-init.js',
    {
      classification: 'rename expectation',
      recommendedResolution: 'Align the npm script with existing scripts/db-init.ts or add an explicit wrapper after confirming the init path is still supported.',
      risk: 'Operators may believe npm run db:init is available, but it fails before database setup.',
      testsNeeded: 'Script-target audit plus a dry-run or smoke test for the chosen database init command.'
    }
  ],
  [
    'db:patch|scripts/schema-sync.js',
    {
      classification: 'needs human decision',
      recommendedResolution: 'Decide whether db:patch should be restored as a migration runner, replaced by the documented SQL workflow, or removed from package.json.',
      risk: 'A stale migration affordance can cause unsafe manual production fixes or failed release prep.',
      testsNeeded: 'Script-target audit and migration runner tests if restored; docs validation if removed or documented absent.'
    }
  ],
  [
    'guide:generate|scripts/generate-tagged-guide.js',
    {
      classification: 'remove stale expectation',
      recommendedResolution: 'Remove guide:generate unless an owner confirms a current tagged-guide generator.',
      risk: 'Stale tooling implies a documentation workflow that cannot run and obscures the actual docs update path.',
      testsNeeded: 'Script-target audit and docs workflow validation for the retained generator.'
    }
  ],
  [
    'sync:auto|scripts/auto-sync-watcher.js',
    {
      classification: 'rename expectation',
      recommendedResolution: 'Make sync:auto an alias of the existing sync:watch command, or remove it if sync:watch is the only supported entrypoint.',
      risk: 'Duplicate watcher names drift; users may run the broken alias instead of the documented watcher.',
      testsNeeded: 'Script-target audit and a non-mutating CLI startup test for the sync command.'
    }
  ],
  [
    'test:doc-workflow|scripts/test-doc-workflow.js',
    {
      classification: 'remove stale expectation',
      recommendedResolution: 'Remove test:doc-workflow or replace it with an existing documented docs audit command if CI still needs an npm alias.',
      risk: 'A broken npm validation target creates false confidence around documentation workflow coverage.',
      testsNeeded: 'Script-target audit and docs audit workflow validation.'
    }
  ]
]);

function normalizeRelativePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function toRepoRelative(filePath) {
  return normalizeRelativePath(path.relative(REPO_ROOT, filePath));
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonIfExists(filePath) {
  const raw = readTextIfExists(filePath);
  if (raw === null) {
    return null;
  }
  return JSON.parse(raw);
}

function collectSourceFiles(rootPath) {
  if (!fs.existsSync(rootPath)) {
    return [];
  }

  const discovered = [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...collectSourceFiles(entryPath));
      continue;
    }

    if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      discovered.push(entryPath);
    }
  }

  return discovered.sort((left, right) => left.localeCompare(right));
}

function extractScriptPathReferences(command) {
  const references = [];
  const segments = String(command).split('&&').map((segment) => segment.trim()).filter(Boolean);
  let currentWorkingDirectory = REPO_ROOT;

  for (const segment of segments) {
    const cdMatch = /^cd\s+([^&|;]+)$/u.exec(segment);
    if (cdMatch) {
      currentWorkingDirectory = path.resolve(currentWorkingDirectory, cdMatch[1].trim());
      continue;
    }

    const scriptPathPattern = /(?:^|\s)((?:\.\/)?(?:scripts|daemon-python\/scripts)\/[A-Za-z0-9_.\-\/]+\.(?:js|mjs|cjs|ts|py))/gu;
    for (const match of segment.matchAll(scriptPathPattern)) {
      const rawReference = match[1].replace(/^\.\//u, '');
      const resolvedPath = rawReference.startsWith('daemon-python/')
        ? path.resolve(REPO_ROOT, rawReference)
        : path.resolve(currentWorkingDirectory, rawReference);
      references.push({
        raw: rawReference,
        resolvedPath,
        relativePath: toRepoRelative(resolvedPath)
      });
    }
  }

  return references.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function classifyMissingScriptTarget(scriptName, missingPath) {
  return SCRIPT_TARGET_CLASSIFICATIONS.get(`${scriptName}|${missingPath}`) ?? {
    classification: 'needs human decision',
    recommendedResolution: 'Decide whether to restore, rename, remove, or document this missing script target.',
    risk: 'A package script points at a file that does not exist in this checkout.',
    testsNeeded: 'Script-target audit after the owner decision is implemented.'
  };
}

function buildScriptTargetReport() {
  const packageJson = readJsonIfExists(path.join(REPO_ROOT, 'package.json'));
  if (!packageJson?.scripts || typeof packageJson.scripts !== 'object') {
    return {
      status: 'error',
      findings: [
        {
          script: 'package.json',
          finding: 'package.json scripts section is missing or malformed.',
          severity: 'error',
          blocking: true
        }
      ]
    };
  }

  const findings = [];
  for (const [scriptName, command] of Object.entries(packageJson.scripts)) {
    for (const reference of extractScriptPathReferences(command)) {
      if (fs.existsSync(reference.resolvedPath)) {
        continue;
      }

      const isAuditTarget = scriptName.startsWith('audit');
      const classification = classifyMissingScriptTarget(scriptName, reference.relativePath);
      findings.push({
        script: scriptName,
        command,
        missingPath: reference.relativePath,
        finding: `npm script references missing file ${reference.relativePath}`,
        classification: classification.classification,
        severity: isAuditTarget ? 'error' : 'warning',
        blocking: isAuditTarget,
        recommendedResolution: classification.recommendedResolution,
        risk: classification.risk,
        testsNeeded: classification.testsNeeded,
        recommendedAction: isAuditTarget
          ? 'Restore the audit script target before relying on audit:all.'
          : classification.recommendedResolution
      });
    }
  }

  return {
    status: findings.some((finding) => finding.blocking) ? 'error' : findings.length > 0 ? 'warning' : 'ok',
    findings: findings.sort((left, right) => `${left.script}:${left.missingPath}`.localeCompare(`${right.script}:${right.missingPath}`))
  };
}

function buildOpenAiComplianceReport() {
  const findings = [];
  const sourceFiles = SCAN_ROOTS.flatMap((scanRoot) => collectSourceFiles(path.join(REPO_ROOT, scanRoot)));

  for (const filePath of sourceFiles) {
    const relativePath = toRepoRelative(filePath);
    const content = fs.readFileSync(filePath, 'utf8');

    if (relativePath !== SELF_FILE && /\b_thenUnwrap\b/u.test(content)) {
      findings.push({
        file: relativePath,
        finding: 'Private OpenAI SDK helper pattern _thenUnwrap found.',
        severity: 'error',
        blocking: true,
        recommendedAction: 'Replace private SDK helper usage with public SDK response handling.'
      });
    }

    if (/\bnew\s+OpenAI\s*\(/u.test(content) && !OPENAI_CONSTRUCTOR_ALLOWLIST.has(relativePath)) {
      const knownMigrationScript = KNOWN_OPENAI_MIGRATION_SCRIPTS.has(relativePath);
      findings.push({
        file: relativePath,
        finding: 'Raw OpenAI SDK constructor outside canonical adapter boundary.',
        severity: knownMigrationScript ? 'warning' : 'error',
        blocking: knownMigrationScript ? KNOWN_OPENAI_MIGRATION_EXCEPTION.blocking : true,
        exception: knownMigrationScript ? KNOWN_OPENAI_MIGRATION_EXCEPTION : null,
        recommendedAction: knownMigrationScript
          ? 'Migrate this script after adapter methods cover the script use case.'
          : 'Move constructor usage behind the TypeScript or Python OpenAI adapter boundary.'
      });
    }
  }

  return {
    status: findings.some((finding) => finding.blocking) ? 'error' : findings.length > 0 ? 'warning' : 'ok',
    findings: findings.sort((left, right) => String(left.file).localeCompare(String(right.file)))
  };
}

function buildRailwayReadinessReport() {
  const serverRaw = readTextIfExists(path.join(REPO_ROOT, 'src', 'server.ts')) ?? '';
  const healthRaw = readTextIfExists(path.join(REPO_ROOT, 'src', 'routes', 'health.ts')) ?? '';
  const launcherRaw = readTextIfExists(path.join(REPO_ROOT, 'scripts', 'start-railway-service.mjs')) ?? '';
  const railwayConfigExists = fs.existsSync(path.join(REPO_ROOT, 'railway.json')) || fs.existsSync(path.join(REPO_ROOT, 'railway.toml'));
  const checks = [
    {
      id: 'config_as_code',
      ok: railwayConfigExists,
      evidence: railwayConfigExists ? 'railway.json or railway.toml exists' : 'railway config file missing'
    },
    {
      id: 'web_bind_host',
      ok: serverRaw.includes('resolveServerBindConfig') && serverRaw.includes('app.listen(bindConfig.port, bindConfig.host'),
      evidence: 'src/server.ts resolves bind config and passes host to app.listen'
    },
    {
      id: 'ready_alias',
      ok: healthRaw.includes("router.get('/ready'") && launcherRaw.includes("'/ready'"),
      evidence: 'HTTP router and worker health launcher expose /ready'
    },
    {
      id: 'graceful_shutdown',
      ok: serverRaw.includes("process.once('SIGTERM'") && serverRaw.includes('closeHttpServer'),
      evidence: 'src/server.ts registers SIGTERM and closes the HTTP server'
    }
  ];

  return {
    status: checks.every((check) => check.ok) ? 'ok' : 'warning',
    checks
  };
}

function buildPythonParityReport() {
  const pythonAuditPath = path.join(REPO_ROOT, 'daemon-python', 'scripts', 'continuous_audit.py');
  const adapterRaw = readTextIfExists(path.join(REPO_ROOT, 'daemon-python', 'arcanos', 'openai', 'openai_adapter.py')) ?? '';
  const gptClientRaw = readTextIfExists(path.join(REPO_ROOT, 'daemon-python', 'arcanos', 'gpt_client.py')) ?? '';

  const checks = [
    {
      id: 'audit_script',
      ok: fs.existsSync(pythonAuditPath),
      evidence: 'daemon-python/scripts/continuous_audit.py exists'
    },
    {
      id: 'openai_store_config',
      ok: adapterRaw.includes('Config.OPENAI_STORE'),
      evidence: 'Python OpenAI adapter reads OPENAI_STORE through Config'
    },
    {
      id: 'zero_generation_values',
      ok: !/temperature=temperature\s+or\s+Config\.TEMPERATURE/u.test(gptClientRaw)
        && !/max_tokens=max_tokens\s+or\s+Config\.MAX_TOKENS/u.test(gptClientRaw),
      evidence: 'GPTClient should preserve explicit 0/0.0 generation overrides'
    }
  ];

  return {
    status: checks.every((check) => check.ok) ? 'ok' : 'warning',
    checks
  };
}

function buildReport(options) {
  const scriptTargets = buildScriptTargetReport();
  const openAiCompliance = buildOpenAiComplianceReport();
  const railwayReadiness = buildRailwayReadinessReport();
  const pythonParity = buildPythonParityReport();
  const blockingFindings = [
    ...scriptTargets.findings.filter((finding) => finding.blocking),
    ...openAiCompliance.findings.filter((finding) => finding.blocking)
  ];
  const warningFindings = [
    ...scriptTargets.findings,
    ...openAiCompliance.findings
  ].filter((finding) => !finding.blocking);

  return {
    tool: 'arcanos-continuous-audit',
    mode: {
      recursive: options.recursive,
      railwayCheck: options.railwayCheck,
      autoFixRequested: options.autoFixRequested,
      autoFixApplied: false
    },
    summary: {
      status: blockingFindings.length > 0 ? 'error' : warningFindings.length > 0 ? 'warning' : 'ok',
      blockingFindings: blockingFindings.length,
      warningFindings: warningFindings.length,
      scriptTargetFindings: scriptTargets.findings.length,
      openAiFindings: openAiCompliance.findings.length
    },
    reports: {
      scriptTargets,
      openAiCompliance,
      railwayReadiness,
      pythonParity
    }
  };
}

function renderMarkdown(report) {
  const lines = [
    '# Continuous Audit',
    '',
    `- Status: ${report.summary.status}`,
    `- Blocking findings: ${report.summary.blockingFindings}`,
    `- Script target findings: ${report.summary.scriptTargetFindings}`,
    `- OpenAI findings: ${report.summary.openAiFindings}`,
    '',
    '## Script Targets',
    ''
  ];

  if (report.reports.scriptTargets.findings.length === 0) {
    lines.push('- No missing script targets detected.');
  } else {
    for (const finding of report.reports.scriptTargets.findings) {
      lines.push(`- ${finding.severity}: ${finding.script} -> ${finding.missingPath} (${finding.classification}): ${finding.recommendedResolution}`);
    }
  }

  lines.push('', '## OpenAI Compliance', '');
  if (report.reports.openAiCompliance.findings.length === 0) {
    lines.push('- No OpenAI SDK guardrail findings detected.');
  } else {
    for (const finding of report.reports.openAiCompliance.findings) {
      const exception = finding.exception ? ` [exception: ${finding.exception.policy}]` : '';
      lines.push(`- ${finding.severity}: ${finding.file}: ${finding.finding}${exception}`);
    }
  }

  lines.push('', '## Railway Readiness', '');
  for (const check of report.reports.railwayReadiness.checks) {
    lines.push(`- ${check.ok ? 'ok' : 'missing'}: ${check.id}`);
  }

  lines.push('', '## Python Parity', '');
  for (const check of report.reports.pythonParity.checks) {
    lines.push(`- ${check.ok ? 'ok' : 'missing'}: ${check.id}`);
  }

  return `${lines.join('\n')}\n`;
}

function parseOptions(argv) {
  return {
    recursive: argv.includes('--recursive'),
    railwayCheck: argv.includes('--railway-check'),
    autoFixRequested: argv.includes('--auto-fix'),
    format: argv.includes('--markdown') || argv.includes('--format=markdown') ? 'markdown' : 'json'
  };
}

const options = parseOptions(process.argv.slice(2));
const report = buildReport(options);
if (options.format === 'markdown') {
  process.stdout.write(renderMarkdown(report));
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

process.exitCode = report.summary.blockingFindings > 0 ? 1 : 0;
