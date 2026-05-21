#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const artifactsRoot = resolve(repoRoot, 'local_artifacts');
const defaultDir = 'local_artifacts/gptoss-single-json-overfit';
const reportPaths = {
  baseline: `${defaultDir}/eval-baseline.json`,
  forceFinal: `${defaultDir}/eval-force-final.json`,
  forceFinalJsonPrefill: `${defaultDir}/eval-force-final-json-prefill.json`,
};
const outputPath = `${defaultDir}/generation-channel-decision.json`;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));
}

function ensureLocalArtifact(path) {
  const resolved = resolve(repoRoot, path);
  const relativePath = relative(artifactsRoot, resolved);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`decision report must stay under local_artifacts: ${path}`);
  }
  return resolved;
}

function entries(report) {
  return [...(report.results ?? []), ...(report.failures ?? [])];
}

function reportPassed(report) {
  return report.ok === true && report.failed === 0;
}

function textEntries(report) {
  return entries(report).map((entry) => [
    entry.rawGeneratedTextSummary,
    entry.finalText,
    entry.assembledFinalText,
    entry.observedSummary,
    entry.reason,
  ].filter(Boolean).join(' '));
}

function startsWithAnalysis(report) {
  return textEntries(report).some((text) => /^analysis\b|analysisThe user/i.test(String(text).trim()));
}

function emitsAnalysis(report) {
  return textEntries(report).some((text) => /\banalysis(The user| channel| prefix)?\b/i.test(String(text)));
}

function hasValidJson(report) {
  return entries(report).some((entry) => entry.validJson === true);
}

function hasRequiredJsonFields(report) {
  return entries(report).some((entry) => entry.requiredJsonFieldsPresent === true);
}

function startsJson(report) {
  return entries(report).some((entry) => {
    const text = String(entry.assembledFinalText ?? entry.finalText ?? entry.rawGeneratedTextSummary ?? '').trim();
    return text.startsWith('{') || entry.jsonPrefillApplied === true;
  });
}

function boundaryFailed(report) {
  const combined = [
    report.message,
    ...textEntries(report),
  ].filter(Boolean).join(' ');
  return /boundary|final-channel/i.test(combined);
}

function chooseDecision(reports) {
  const baselinePassed = reportPassed(reports.baseline);
  const forcePassed = reportPassed(reports.forceFinal);
  const prefillPassed = reportPassed(reports.forceFinalJsonPrefill);
  const anyValidJson = hasValidJson(reports.baseline) || hasValidJson(reports.forceFinal) || hasValidJson(reports.forceFinalJsonPrefill);
  const forcedRequiredFields = hasRequiredJsonFields(reports.forceFinal) || hasRequiredJsonFields(reports.forceFinalJsonPrefill);
  const forcedStartsJson = startsJson(reports.forceFinal) || startsJson(reports.forceFinalJsonPrefill);
  const forcedEmitsAnalysis = emitsAnalysis(reports.forceFinal) || emitsAnalysis(reports.forceFinalJsonPrefill);

  if (!baselinePassed && forcePassed) {
    return ['final_channel_prefill_solves_generation', 'baseline failed and force-final-channel passed'];
  }
  if (!forcePassed && prefillPassed) {
    return ['json_prefill_required', 'force-final-channel failed and force-final-channel plus JSON prefill passed'];
  }
  if (anyValidJson && forcedRequiredFields && (!forcePassed || !prefillPassed)) {
    return ['extraction_or_scoring_bug', 'a forced mode produced valid required JSON but scorer still failed'];
  }
  if (forcedStartsJson && !forcedRequiredFields) {
    return ['target_likelihood_insufficient', 'forced modes reached JSON start but did not produce required fields'];
  }
  if (forcedEmitsAnalysis) {
    return [
      boundaryFailed(reports.forceFinal) || boundaryFailed(reports.forceFinalJsonPrefill)
        ? 'boundary_derivation_failed'
        : 'generation_still_fails_despite_prefill',
      'forced modes still emitted analysis-style text',
    ];
  }
  if (anyValidJson && (!forcePassed || !prefillPassed)) {
    return ['extraction_or_scoring_bug', 'valid JSON appeared in a failing forced report'];
  }
  return ['generation_still_fails_despite_prefill', 'no forced mode passed strict eval'];
}

try {
  const reports = {
    baseline: readJson(reportPaths.baseline),
    forceFinal: readJson(reportPaths.forceFinal),
    forceFinalJsonPrefill: readJson(reportPaths.forceFinalJsonPrefill),
  };
  const [decision, decisionReason] = chooseDecision(reports);
  const output = {
    ok: true,
    kind: 'gptoss_generation_channel_decision',
    schemaVersion: 1,
    decision,
    decisionReason,
    reports: reportPaths,
    evidence: {
      baselinePassed: reportPassed(reports.baseline),
      baselineStartsAnalysis: startsWithAnalysis(reports.baseline),
      forceFinalPassed: reportPassed(reports.forceFinal),
      forceFinalStartsAnalysis: startsWithAnalysis(reports.forceFinal),
      forceFinalValidJson: hasValidJson(reports.forceFinal),
      forceFinalJsonPrefillPassed: reportPassed(reports.forceFinalJsonPrefill),
      forceFinalJsonPrefillStartsAnalysis: startsWithAnalysis(reports.forceFinalJsonPrefill),
      forceFinalJsonPrefillValidJson: hasValidJson(reports.forceFinalJsonPrefill),
      forceFinalJsonPrefillRequiredFieldsPresent: hasRequiredJsonFields(reports.forceFinalJsonPrefill),
    },
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    noOpenAiOutputUsed: true,
  };

  const resolvedOutput = ensureLocalArtifact(outputPath);
  mkdirSync(dirname(resolvedOutput), { recursive: true });
  writeFileSync(resolvedOutput, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  const failure = {
    ok: false,
    kind: 'gptoss_generation_channel_decision',
    error: 'decision_report_failed',
    message: error instanceof Error ? error.message : String(error),
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    noOpenAiOutputUsed: true,
  };
  console.log(JSON.stringify(failure, null, 2));
  process.exit(2);
}
