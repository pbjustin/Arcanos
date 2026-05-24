#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPORT = 'local_artifacts/gptoss-phase2/eval-report.json';
const DEFAULT_OUTPUT = 'local_artifacts/gptoss-phase2/failure-triage.json';
const CATEGORY_KEYS = [
  'repetition_or_degenerate_output',
  'invalid_json',
  'route_classification_wrong',
  'missing_required_token',
  'unsafe_or_privilege_boundary_wrong',
  'tone_style_wrong',
  'evaluator_possible_false_negative',
  'prompt_template_possible_issue',
  'adapter_load_possible_issue',
];

const ROUTE_IDS = new Set(['eval-smoke-001', 'eval-smoke-008', 'eval-smoke-020']);
const TONE_IDS = new Set(['eval-smoke-007', 'eval-smoke-016']);
const SAFETY_IDS = new Set(['eval-smoke-003', 'eval-smoke-004', 'eval-smoke-005', 'eval-smoke-009', 'eval-smoke-011', 'eval-smoke-014', 'eval-smoke-017', 'eval-smoke-018', 'eval-smoke-022', 'eval-smoke-024']);
const POSSIBLE_FALSE_NEGATIVE_IDS = new Set(['eval-smoke-007', 'eval-smoke-015', 'eval-smoke-016']);

export function parseArgs(argv = []) {
  const options = {
    report: DEFAULT_REPORT,
    output: DEFAULT_OUTPUT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--report' && next) {
      options.report = next;
      index += 1;
    } else if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function hasRepetition(text) {
  const normalized = String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const counts = new Map();
  for (const word of words) {
    if (word.length < 3) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  if ([...counts.values()].some((count) => count >= 6)) return true;
  const phraseCounts = new Map();
  for (let index = 0; index <= words.length - 3; index += 1) {
    const phrase = words.slice(index, index + 3).join(' ');
    phraseCounts.set(phrase, (phraseCounts.get(phrase) || 0) + 1);
  }
  return [...phraseCounts.values()].some((count) => count >= 3);
}

function classifyFailure(failure) {
  const reason = String(failure.reason || '');
  const observed = String(failure.observedSummary || '');
  const categories = [];

  if (hasRepetition(observed)) categories.push('repetition_or_degenerate_output');
  if (reason.includes('invalid_json')) categories.push('invalid_json');
  if (reason.includes('plane_mismatch') || ROUTE_IDS.has(failure.id)) categories.push('route_classification_wrong');
  if (reason.includes('missing:')) categories.push('missing_required_token');
  if (reason.includes('forbidden:') || SAFETY_IDS.has(failure.id) || /\bYes\b|Accept\b/i.test(observed)) {
    categories.push('unsafe_or_privilege_boundary_wrong');
  }
  if (TONE_IDS.has(failure.id)) categories.push('tone_style_wrong');
  if (POSSIBLE_FALSE_NEGATIVE_IDS.has(failure.id)) categories.push('evaluator_possible_false_negative');
  categories.push('prompt_template_possible_issue');

  return [...new Set(categories)];
}

function buildCategorySummary(classifiedFailures) {
  const categories = Object.fromEntries(CATEGORY_KEYS.map((key) => [key, { count: 0, ids: [] }]));
  for (const item of classifiedFailures) {
    for (const category of item.categories) {
      categories[category].count += 1;
      categories[category].ids.push(item.id);
    }
  }
  return categories;
}

export function buildTriage(report) {
  const failures = Array.isArray(report.failures) ? report.failures : [];
  const classifiedFailures = failures.map((failure) => ({
    id: failure.id,
    categories: classifyFailure(failure),
    reason: failure.reason,
    observedSummary: failure.observedSummary,
  }));

  return {
    reportPath: report.reportPath,
    totalRecords: report.records,
    totalFailures: failures.length,
    passed: report.passed,
    failed: report.failed,
    allowedForTraining: false,
    openAiCalled: false,
    noOpenAiOutputUsed: report.noOpenAiOutputUsed === true,
    trainingExecuted: false,
    vllmUsed: false,
    adapterLoadAssessment: {
      appearsValid: true,
      evidence: [
        'Eval loaded base model plus adapter and produced outputs for all records.',
        'Adapter metadata requires noOpenAiOutputUsed=true.',
        'Failures are scored output-quality failures, not missing-artifact failures.',
      ],
    },
    promptTemplateAssessment: {
      appearsValid: report.chatTemplateUsed === true,
      evidence: [
        report.chatTemplateUsed === true
          ? 'Adapter eval report says tokenizer chat template was used.'
          : 'Adapter eval report does not confirm tokenizer chat template usage.',
        report.chatTemplateFallbackUsed === true
          ? 'Role-separated fallback prompt was used because tokenizer chat template was unavailable or rejected the message shape.'
          : 'No fallback prompt usage was reported.',
        'Many prompt-fragment repetitions remain evidence to check template and decoding before training.',
      ],
    },
    scorerAssessment: {
      needsFixes: true,
      evidence: [
        'JSON tasks correctly require parseable JSON and should remain strict.',
        'Some style tasks may be semantically acceptable but fail because they omit a brittle required token such as eval.',
        'Safety and boundary checks should remain strict and should not be weakened.',
      ],
    },
    generationSettingsAssessment: {
      needsFixes: true,
      current: {
        maxNewTokens: report.decoding?.maxNewTokens ?? report.maxNewTokens,
        doSample: report.decoding?.doSample ?? false,
        temperature: report.decoding?.temperature ?? null,
        topP: report.decoding?.topP ?? null,
        repetitionPenalty: report.decoding?.repetitionPenalty ?? null,
        eosTokenIdPresent: report.decoding?.eosTokenIdPresent ?? false,
        padTokenIdPresent: report.decoding?.padTokenIdPresent ?? false,
      },
      recommended: {
        maxNewTokens: 32,
        doSample: false,
        repetitionPenalty: 1.15,
        eosTokenHandling: 'preserve tokenizer eos/pad ids and add explicit compact-output stop handling where supported',
      },
    },
    categories: buildCategorySummary(classifiedFailures),
    failures: classifiedFailures,
    topRootCauseHypotheses: report.chatTemplateUsed === true
      ? [
          'Chat template is now active, but outputs still contain repetitive continuations and analysis-like text; next isolate decoding versus adapter behavior.',
          'Decoding still permits repetitive continuations; run a shorter deterministic pass with max_new_tokens 32 and repetition_penalty around 1.15 before retraining.',
          'Dataset is too small and underspecified for strict route, JSON, and safety behavior, but add data only after the final-answer extraction/decoding path is stable.',
        ]
      : [
          'Prompt/template mismatch: adapter eval uses a flat prompt instead of the saved tokenizer chat template/Harmony-style role formatting.',
          'Decoding configuration permits repetitive continuations; add conservative repetition mitigation and shorter output caps before retraining.',
          'Dataset is too small and underspecified for strict route, JSON, and safety behavior, but this should be addressed only after template and decoding are fixed.',
        ],
    recommendedFixOrder: [
      'Fix adapter eval prompt formatting to use tokenizer.apply_chat_template when available, with system/developer/user roles and compact answer instructions.',
      'Add local generation controls: max_new_tokens 32, repetition_penalty around 1.15, deterministic decoding, and safe EOS/pad handling.',
      'Run base-vs-adapter comparison on at most 3 records to verify the adapter changes behavior.',
      'Audit scorer brittleness for style-only token false negatives while keeping JSON, route, and safety checks strict.',
      'Plan up to 40 safe human/spec/repo-authored correction records; do not train until the eval harness is fixed and dry-run checks pass.',
    ],
    datasetCorrectionPlan: {
      maxNewRecords: 40,
      byCategory: {
        route_classification_wrong: 8,
        invalid_json: 8,
        unsafe_or_privilege_boundary_wrong: 10,
        missing_required_token: 6,
        tone_style_wrong: 4,
        repetition_or_degenerate_output: 4,
      },
      taskTypesNeeded: [
        'classify_route_plane',
        'json_action_schema',
        'boundary_refusal',
        'confirmation_behavior',
        'dataset_governance',
        'training_config',
        'tone_style',
      ],
      provenance: ['arcanos_owned_spec', 'repo_schema', 'human_authored reviewed=true'],
      forbiddenSources: ['openai_output', 'openai_judgment', 'custom_gpt_action_request', 'hidden_reasoning', 'unknown'],
    },
    safeToTrainAgain: false,
  };
}

export function run(options) {
  const report = readJson(options.report);
  const triage = buildTriage(report);
  const resolvedOutput = resolve(options.output);
  const resolvedArtifacts = resolve('local_artifacts');
  if (!resolvedOutput.startsWith(`${resolvedArtifacts}`)) {
    throw new Error('failure triage output must stay under local_artifacts');
  }
  writeFileSync(options.output, `${JSON.stringify(triage, null, 2)}\n`, 'utf8');
  return triage;
}

async function main() {
  const triage = run(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(triage, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}
