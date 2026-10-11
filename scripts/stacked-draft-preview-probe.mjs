#!/usr/bin/env node
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runNativePrPreviewE2e } from './native-pr-preview-e2e.mjs';

function requireCondition(value, code) { if (!value) throw new Error(code); }
export function validateProbeTarget(authorization, deployment, now = Date.now()) {
  const ownership = deployment?.ownership;
  requireCondition(authorization?.version === 1 && authorization.stack?.length === 3
    && authorization.stack.at(-1).prNumber === 1535
    && deployment?.schemaVersion === 1 && deployment.status === 'VERIFIED'
    && ownership?.repository === 'pbjustin/Arcanos'
    && ownership.controllerSha === authorization.controllerSha
    && ownership.candidateSha === authorization.stack.at(-1).headSha
    && ownership.environmentName === 'pr-1532aa-1535'
    && ownership.expiresAt === authorization.expiresAt
    && Number.isFinite(Date.parse(ownership.expiresAt))
    && Date.parse(ownership.expiresAt) > now && Date.parse(ownership.expiresAt) - now <= 7200_000
    && /^ghcr\.io\/pbjustin\/arcanos-stacked-preview@sha256:[0-9a-f]{64}$/u.test(ownership.image)
    && typeof deployment.hosts?.web === 'string' && typeof deployment.hosts?.worker === 'string'
    && deployment.hosts.web !== deployment.hosts.worker && !deployment.cleanup,
  'STACKED_PREVIEW_PROBE_TARGET_UNVERIFIED');
  return ownership;
}

export async function runStackedDraftPreviewProbe({ authorization, deployment, gitEvidenceRoot,
  execute = false, allowNetwork = false, fetchImpl = globalThis.fetch,
  localGitState, expectedBackstageBookerOpenApiDocument, now = Date.now } = {}) {
  const ownership = validateProbeTarget(authorization, deployment, now());
  requireCondition(execute === allowNetwork, 'STACKED_PREVIEW_PROBE_NETWORK_OPT_IN_INCOMPLETE');
  const args = ['--pr-number', '1535', '--commit-sha', ownership.candidateSha,
    '--web-base-url', deployment.hosts.web, '--worker-base-url', deployment.hosts.worker];
  if (gitEvidenceRoot) args.push('--git-evidence-root', gitEvidenceRoot);
  if (execute) args.push('--execute', '--allow-network');
  const report = await runNativePrPreviewE2e({ args, fetchImpl, localGitState,
    expectedBackstageBookerOpenApiDocument, requestScope: 'stacked-draft-gaming-synthetic' });
  const guide = report.checks.find(check => check.caseId === 'gaming-query-guide');
  return { ...report, deployment: { environmentId: ownership.environmentId, image: ownership.image,
    runId: ownership.runId }, performance: { guideRequestElapsedMs: guide?.elapsedMs ?? null,
    requestTimingScope: 'HTTP transport, response parsing and trusted verification', retries: 0,
    extractionLatencyMs: null, sourceValidationLatencyMs: null, memoryUsageBytes: null,
    limitation: 'Stage and Railway resource metrics require separate runtime receipts.' },
  boundaries: { livePublisherAcquisition: false, paidProviderCalls: false,
    trinityGeneration: false, realPluginAuthentication: false, productionRelease: false } };
}

function readJson(file) {
  requireCondition(statSync(file).isFile() && statSync(file).size <= 128 * 1024, 'STACKED_PREVIEW_PROBE_INPUT_INVALID');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export function parseProbeArguments(args) {
  const values = {};
  const valueKeys = new Set(['--authorization', '--deployment', '--git-evidence-root', '--output']);
  const flagKeys = new Set(['--execute', '--allow-network']);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    requireCondition(!(key in values) && (valueKeys.has(key) || flagKeys.has(key)), 'STACKED_PREVIEW_PROBE_ARGUMENT_INVALID');
    if (flagKeys.has(key)) values[key] = true;
    else {
      const value = args[++index];
      requireCondition(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), 'STACKED_PREVIEW_PROBE_ARGUMENT_INVALID');
      values[key] = value;
    }
  }
  requireCondition(values['--authorization'] && values['--deployment'] && values['--git-evidence-root'],
    'STACKED_PREVIEW_PROBE_ARGUMENT_INVALID');
  return values;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output;
  try {
    requireCondition(!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && !process.env.RAILWAY_API_TOKEN
      && !process.env.RAILWAY_TOKEN && !process.env.OPENAI_API_KEY, 'STACKED_PREVIEW_PROBE_CREDENTIALS_FORBIDDEN');
    const args = parseProbeArguments(process.argv.slice(2));
    output = args['--output'] ?? '.stacked-preview/verification.json';
    const report = await runStackedDraftPreviewProbe({ authorization: readJson(args['--authorization']),
      deployment: readJson(args['--deployment']), gitEvidenceRoot: args['--git-evidence-root'],
      execute: args['--execute'] === true, allowNetwork: args['--allow-network'] === true });
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ executed: report.executed, requestsMade: report.summary.requestsMade,
      status: report.executed ? 'VERIFIED' : 'NOT VERIFIED' }));
  } catch (error) {
    const code = /^[A-Z0-9_]+$/u.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'STACKED_PREVIEW_PROBE_FAILED';
    if (output) {
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify({ status: 'NOT VERIFIED', errorCode: code })}\n`);
    }
    console.error(code); process.exitCode = 1;
  }
}
