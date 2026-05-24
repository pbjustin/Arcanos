import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  REQUIRED_RUNTIME_SUPPORTS as DEFAULT_RUNTIME_SUPPORTS,
  assertRuntimeReportPath,
} from './effective-router-runtime.mjs';
import { redactText } from './effective-router-audit-log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

export const DEFAULT_RELEASE_GATE_REPORT =
  'local_artifacts/gptoss-runtime/release-gate-report.json';

export const RELEASE_GATE_COMMANDS = [
  { script: 'gptoss:baseline:regress', cloudGate: false },
  { script: 'gptoss:adapter:eval:effective-router:regress', cloudGate: false },
  { script: 'gptoss:runtime:request:regress', cloudGate: false },
  { script: 'gptoss:runtime:readiness', cloudGate: false },
  { script: 'gptoss:runtime:release-manifest', cloudGate: false },
  { script: 'gptoss:runtime:cloud-gate', cloudGate: true },
];

export const FORBIDDEN_TRACKED_PATTERNS = [
  'local_artifacts/',
  'unsloth_compiled_cache/',
  '.cache/huggingface/',
  'huggingface/hub/',
  'adapter_model.safetensors',
  'adapter_config.json',
  'checkpoint-',
  '.safetensors',
  '.gguf',
  '.pt',
  '.pth',
  'db-dump',
  'db_dump',
  'database-dump',
  'database_dump',
  'dump.sql',
  '.dump',
  'railway.log',
  'railway-output',
];

const REQUIRED_GITIGNORE_ENTRIES = ['local_artifacts/', 'unsloth_compiled_cache/'];
const FORBIDDEN_TRACKED_REGEXES = [
  /^local_artifacts\//,
  /^unsloth_compiled_cache\//,
  /(^|\/)adapter_model\.(safetensors|bin)$/,
  /(^|\/)adapter_config\.json$/,
  /(^|\/)pytorch_model.*\.bin$/,
  /(^|\/)model[-_.].*\.(safetensors|bin|gguf)$/,
  /(^|\/)checkpoint-[^/]+(\/|$)/,
  /(^|\/)trainer_state\.json$/,
  /(^|\/)training_args\.bin$/,
  /(^|\/)optimizer\.pt$/,
  /(^|\/)scheduler\.pt$/,
  /\.(safetensors|gguf|ckpt|onnx)$/,
];

const SAFETY_DIRTY_TRUE_FLAGS = [
  'openAiCalled',
  'trainingExecuted',
  'vllmUsed',
  'railwayCliUsed',
  'liveDbUsed',
  'cloudReady',
  'customGptReady',
];

const PREVIEW_LIMIT = 6000;
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function npmRunInvocation(script) {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath, 'run', script],
    };
  }

  return {
    command: npmCommand,
    args: ['run', script],
  };
}

export function redactedPreview(value, limit = PREVIEW_LIMIT) {
  const text = redactText(String(value ?? ''));
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export function extractLastJson(text) {
  const source = String(text ?? '');
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  let last = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = source.slice(start, index + 1);
        try {
          last = JSON.parse(candidate);
        } catch {
          // Logs can contain brace-balanced non-JSON snippets. Keep scanning.
        }
        start = -1;
      }
    }
  }

  return last;
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });

  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? String(result.error ?? ''),
  };
}

function commandLabel(command) {
  if (command.script) {
    return `npm run ${command.script}`;
  }

  return `${command.command} ${(command.args ?? []).join(' ')}`.trim();
}

function scoreToString(score) {
  if (typeof score === 'string') {
    return score;
  }

  if (
    score &&
    typeof score === 'object' &&
    Number.isFinite(score.passed) &&
    Number.isFinite(score.records)
  ) {
    return `${score.passed}/${score.records}`;
  }

  return null;
}

function collectObjects(value, visit) {
  if (!value || typeof value !== 'object') {
    return;
  }

  visit(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjects(item, visit);
    }
    return;
  }

  for (const item of Object.values(value)) {
    collectObjects(item, visit);
  }
}

function pushFailure(failures, code, detail = undefined) {
  failures.push(detail ? `${code}: ${detail}` : code);
}

function validateSafety(parsedReports, commandRecords, failures) {
  for (const [name, parsed] of Object.entries(parsedReports)) {
    collectObjects(parsed, (object) => {
      if (object === parsed?.safetyChecks || object === parsed?.checks) {
        return;
      }

      for (const flag of SAFETY_DIRTY_TRUE_FLAGS) {
        if (object[flag] === true) {
          pushFailure(failures, 'dirty_safety_flag', `${name}.${flag}`);
        }
      }

      if (object.noOpenAiOutputUsed === false) {
        pushFailure(failures, 'dirty_safety_flag', `${name}.noOpenAiOutputUsed`);
      }
    });
  }
}

function getRequiredState(parsedReports) {
  const manifest = parsedReports['gptoss:runtime:release-manifest'] ?? {};
  const readiness = parsedReports['gptoss:runtime:readiness'] ?? {};
  const baseline = parsedReports['gptoss:baseline:regress'] ?? {};
  const effective = parsedReports['gptoss:adapter:eval:effective-router:regress'] ?? {};

  return {
    modelScore:
      scoreToString(manifest.modelScore) ??
      scoreToString(readiness.modelScore) ??
      scoreToString(effective.modelScore) ??
      scoreToString(baseline.modelScore),
    effectiveScore:
      scoreToString(manifest.effectiveScore) ??
      scoreToString(readiness.effectiveScore) ??
      scoreToString(effective.effectiveScore) ??
      scoreToString(baseline.effectiveScore),
    localControlledRuntimeReady:
      manifest.localControlledRuntimeReady ?? readiness.localControlledRuntimeReady,
    modelOnlyReady: manifest.modelOnlyReady ?? readiness.modelOnlyReady,
    cloudReady: manifest.cloudReady ?? readiness.cloudReady,
    customGptReady: manifest.customGptReady ?? readiness.customGptReady,
  };
}

function validateRequiredRuntimeSupports(manifest, failures) {
  const supports = manifest?.requiredRuntimeSupports;
  if (!supports || typeof supports !== 'object') {
    pushFailure(failures, 'runtime_supports_missing');
    return;
  }

  for (const [key, expected] of Object.entries(DEFAULT_RUNTIME_SUPPORTS)) {
    if (expected === true && supports[key] !== true) {
      pushFailure(failures, 'runtime_support_missing', key);
    }
  }
}

function validateScoreReports(parsedReports, failures) {
  const baseline = parsedReports['gptoss:baseline:regress'];
  const effective = parsedReports['gptoss:adapter:eval:effective-router:regress'];
  const manifest = parsedReports['gptoss:runtime:release-manifest'];

  if (!baseline?.modelScore || !scoreToString(baseline.modelScore)) {
    pushFailure(failures, 'model_score_missing', 'baseline regression');
  }

  if (!effective?.modelScore || !scoreToString(effective.modelScore)) {
    pushFailure(failures, 'model_score_missing', 'effective-router regression');
  }

  if (!manifest?.modelScore || !scoreToString(manifest.modelScore)) {
    pushFailure(failures, 'model_score_missing', 'release manifest');
  }

  const effectiveScores = [
    ['baseline regression', scoreToString(baseline?.effectiveScore)],
    ['effective-router regression', scoreToString(effective?.effectiveScore)],
    ['release manifest', scoreToString(manifest?.effectiveScore)],
  ];

  for (const [name, score] of effectiveScores) {
    if (score !== '24/24') {
      pushFailure(failures, 'effective_score_not_24_24', `${name}=${score ?? 'missing'}`);
    }
  }
}

function validateReleaseManifest(parsedReports, failures) {
  const manifest = parsedReports['gptoss:runtime:release-manifest'];
  if (!manifest || typeof manifest !== 'object') {
    pushFailure(failures, 'release_manifest_missing');
    return;
  }

  validateRequiredRuntimeSupports(manifest, failures);

  if (manifest.requestStatus?.smoke?.ok !== true) {
    pushFailure(failures, 'request_smoke_not_passing');
  }

  if (manifest.requestStatus?.regress?.ok !== true) {
    pushFailure(failures, 'request_regress_not_passing');
  }

  const safety = manifest.safetyConfirmations ?? {};
  if (safety.openAiCalled !== false) {
    pushFailure(failures, 'manifest_safety_flag_not_clean', 'openAiCalled');
  }
  if (safety.trainingExecuted !== false) {
    pushFailure(failures, 'manifest_safety_flag_not_clean', 'trainingExecuted');
  }
  if (safety.vllmUsed !== false) {
    pushFailure(failures, 'manifest_safety_flag_not_clean', 'vllmUsed');
  }
  if (safety.railwayCliUsed !== false) {
    pushFailure(failures, 'manifest_safety_flag_not_clean', 'railwayCliUsed');
  }
  if (safety.liveDbUsed !== false) {
    pushFailure(failures, 'manifest_safety_flag_not_clean', 'liveDbUsed');
  }
  if (safety.noOpenAiOutputUsed !== true) {
    pushFailure(failures, 'manifest_safety_flag_not_clean', 'noOpenAiOutputUsed');
  }
}

function validateCloudGate(parsedReports, failures) {
  const cloudGate = parsedReports['gptoss:runtime:cloud-gate'];
  if (!cloudGate || typeof cloudGate !== 'object') {
    pushFailure(failures, 'cloud_gate_report_missing');
    return false;
  }

  const blocked =
    cloudGate.cloudReady === false &&
    cloudGate.customGptReady === false &&
    cloudGate.customGptDirectLocalExposureAllowed === false;

  if (!blocked) {
    pushFailure(failures, 'cloud_gate_not_blocked');
  }

  if (cloudGate.localControlledRuntimeReady !== true) {
    pushFailure(failures, 'cloud_gate_local_runtime_not_ready');
  }

  return blocked;
}

export function validateReleaseState({ parsedReports, commandRecords, artifactExclusion }) {
  const failures = [];

  validateSafety(parsedReports, commandRecords, failures);
  validateScoreReports(parsedReports, failures);
  validateReleaseManifest(parsedReports, failures);

  const state = getRequiredState(parsedReports);
  if (state.modelScore !== '11/24') {
    pushFailure(failures, 'model_score_unexpected', state.modelScore ?? 'missing');
  }
  if (state.effectiveScore !== '24/24') {
    pushFailure(failures, 'effective_score_not_24_24', state.effectiveScore ?? 'missing');
  }
  if (state.localControlledRuntimeReady !== true) {
    pushFailure(failures, 'local_controlled_runtime_not_ready');
  }
  if (state.modelOnlyReady !== false) {
    pushFailure(failures, 'model_only_ready_not_false');
  }
  if (state.cloudReady !== false) {
    pushFailure(failures, 'cloud_ready_not_false');
  }
  if (state.customGptReady !== false) {
    pushFailure(failures, 'custom_gpt_ready_not_false');
  }

  const cloudGateBlocked = validateCloudGate(parsedReports, failures);

  if (artifactExclusion?.ok !== true) {
    pushFailure(
      failures,
      'artifact_exclusion_failed',
      (artifactExclusion?.failures ?? []).join('; ') || 'unknown',
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    state,
    cloudGateBlocked,
  };
}

function matchesForbiddenTrackedPattern(file) {
  const normalized = file.replaceAll('\\', '/');
  return FORBIDDEN_TRACKED_REGEXES.some((pattern) => pattern.test(normalized));
}

export function auditArtifactExclusion({ runCommand = defaultRunCommand, cwd = repoRoot } = {}) {
  const failures = [];

  let gitignoreText = '';
  try {
    gitignoreText = readFileSync(resolve(cwd, '.gitignore'), 'utf8').replace(/\r\n/g, '\n');
  } catch {
    failures.push('gitignore_missing');
  }

  for (const entry of REQUIRED_GITIGNORE_ENTRIES) {
    if (!gitignoreText.split('\n').includes(entry)) {
      failures.push(`gitignore_entry_missing:${entry}`);
    }
  }

  const localArtifactsIgnored = runCommand('git', [
    'check-ignore',
    '-q',
    '--',
    'local_artifacts/__release_gate_probe__',
  ], {
    cwd,
  });
  if (localArtifactsIgnored.status !== 0) {
    failures.push('local_artifacts_not_ignored');
  }

  const unslothCacheIgnored = runCommand('git', [
    'check-ignore',
    '-q',
    '--',
    'unsloth_compiled_cache/__release_gate_probe__.py',
  ], {
    cwd,
  });
  if (unslothCacheIgnored.status !== 0) {
    failures.push('unsloth_compiled_cache_not_ignored');
  }

  const tracked = runCommand('git', ['ls-files'], { cwd });
  if (tracked.status !== 0) {
    failures.push('git_ls_files_failed');
  } else {
    const forbiddenTracked = String(tracked.stdout ?? '')
      .split(/\r?\n/)
      .filter(Boolean)
      .filter(matchesForbiddenTrackedPattern);

    for (const file of forbiddenTracked) {
      failures.push(`forbidden_tracked_artifact:${file}`);
    }
  }

  const unignoredLocalArtifacts = runCommand('git', [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'local_artifacts',
    'unsloth_compiled_cache',
  ], { cwd });
  if (unignoredLocalArtifacts.status !== 0) {
    failures.push('git_ls_unignored_artifacts_failed');
  } else if (String(unignoredLocalArtifacts.stdout ?? '').trim()) {
    failures.push('unignored_local_artifacts_present');
  }

  return {
    ok: failures.length === 0,
    failures,
  };
}

function sanitizeCommandRecord(record) {
  return {
    command: record.command,
    ok: record.ok,
    status: record.status,
    stdoutPreview: record.stdoutPreview,
    stderrPreview: record.stderrPreview,
    cloudGateBlocked: record.cloudGateBlocked,
  };
}

function buildReport({ commandRecords, parsedReports, artifactExclusion, validation }) {
  const state = validation.state;

  return {
    ok: validation.ok,
    modelScore: state.modelScore,
    effectiveScore: state.effectiveScore,
    localControlledRuntimeReady: state.localControlledRuntimeReady,
    modelOnlyReady: state.modelOnlyReady,
    cloudReady: state.cloudReady,
    customGptReady: state.customGptReady,
    cloudGateBlocked: validation.cloudGateBlocked,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    noOpenAiOutputUsed: true,
    artifactExclusionPassed: artifactExclusion.ok,
    failures: validation.failures,
    commands: commandRecords.map(sanitizeCommandRecord),
    reportSources: Object.fromEntries(
      Object.entries(parsedReports).map(([script, report]) => [script, Boolean(report)]),
    ),
  };
}

function writeReport(report, outputPath) {
  assertRuntimeReportPath(outputPath);
  mkdirSync(dirname(resolve(repoRoot, outputPath)), { recursive: true });
  writeFileSync(resolve(repoRoot, outputPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}

export function loadReleaseGateReport(path = DEFAULT_RELEASE_GATE_REPORT) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

export function runReleaseGate({
  runCommand = defaultRunCommand,
  cwd = repoRoot,
  outputPath = DEFAULT_RELEASE_GATE_REPORT,
  write = true,
} = {}) {
  const commandRecords = [];
  const parsedReports = {};

  for (const command of RELEASE_GATE_COMMANDS) {
    const label = commandLabel(command);
    const invocation = npmRunInvocation(command.script);
    const result = runCommand(invocation.command, invocation.args, { cwd });
    const stdoutRaw = result.stdout ?? '';
    const stderrRaw = result.stderr ?? '';
    const parsed = extractLastJson(`${stdoutRaw}\n${stderrRaw}`);
    parsedReports[command.script] = parsed;

    const cloudGateBlocked =
      command.cloudGate &&
      parsed?.cloudReady === false &&
      parsed?.customGptReady === false &&
      parsed?.customGptDirectLocalExposureAllowed === false;

    const ok = command.cloudGate ? cloudGateBlocked : result.status === 0;
    const record = {
      command: label,
      script: command.script,
      ok,
      status: result.status,
      stdoutRaw,
      stderrRaw,
      stdoutPreview: redactedPreview(stdoutRaw),
      stderrPreview: redactedPreview(stderrRaw),
      cloudGateBlocked,
    };
    commandRecords.push(record);

    if (!ok) {
      break;
    }
  }

  const artifactExclusion = auditArtifactExclusion({ runCommand, cwd });
  const validation = validateReleaseState({
    parsedReports,
    commandRecords,
    artifactExclusion,
  });
  const report = buildReport({
    commandRecords,
    parsedReports,
    artifactExclusion,
    validation,
  });

  if (write) {
    writeReport(report, outputPath);
  }

  return report;
}

function main() {
  try {
    const report = runReleaseGate();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const fallbackReport = {
      ok: false,
      modelScore: null,
      effectiveScore: null,
      localControlledRuntimeReady: false,
      modelOnlyReady: false,
      cloudReady: false,
      customGptReady: false,
      cloudGateBlocked: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
      artifactExclusionPassed: false,
      failures: [`release_gate_exception:${redactedPreview(error?.message ?? error, 1000)}`],
      commands: [],
    };
    writeReport(fallbackReport, DEFAULT_RELEASE_GATE_REPORT);
    console.log(JSON.stringify(fallbackReport, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
