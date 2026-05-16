#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { buildBridgePolicy, parsePolicyArgs } from './bridge-policy.mjs';
import { callCandidate, callReference, readBridgeConfig } from './model-clients.mjs';

const DEFAULT_PROMPT = 'Classify this Arcanos request as writing-plane or control-plane: show worker queue status.';

export function parseArgs(argv) {
  const config = {
    mode: 'dry-run',
    prompt: DEFAULT_PROMPT,
    callReference: false,
    showReferenceOutput: false,
    noNetwork: false,
    localOnly: false,
    allowNetwork: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--prompt' && next) {
      config.prompt = next;
      index += 1;
      continue;
    }

    if (flag === '--compare') {
      config.mode = 'compare';
      continue;
    }

    if (flag === '--dry-run') {
      config.mode = 'dry-run';
      continue;
    }

    if (flag === '--call-reference') {
      config.callReference = true;
      continue;
    }

    if (flag === '--enable-openai-reference') {
      config.callReference = true;
      continue;
    }

    if (flag === '--allow-network') {
      config.allowNetwork = true;
      config.localOnly = false;
      continue;
    }

    if (flag === '--execute') {
      config.mode = 'compare';
      continue;
    }

    if (flag === '--show-reference-output') {
      throw new Error('--show-reference-output is disabled: OpenAI reference output must not be included in bridge reports.');
    }

    if (flag === '--no-network') {
      config.noNetwork = true;
      continue;
    }

    if (flag === '--local-only') {
      config.localOnly = true;
      continue;
    }

    throw new Error(`Unknown argument: ${flag}`);
  }

  return config;
}

export function validateOutput({ prompt, candidateOutput = '' }) {
  const trimmed = String(candidateOutput || '').trim();
  const looksControl = /\b(status|queue|worker|deploy|railway|logs?)\b/i.test(prompt);
  const looksWriting = /\b(write|draft|compose|summarize|document)\b/i.test(prompt);

  return {
    schemaValid: true,
    routeValid: looksControl ? /\b(control|status|queue|worker|read|inspect)\b/i.test(trimmed) : true,
    moduleBoundaryValid: !/\bOPENAI_API_KEY|RAILWAY_API_TOKEN|DATABASE_URL|Bearer\s+/i.test(trimmed),
    safetyValid: !/\bsk-[A-Za-z0-9_-]{20,}\b|hidden reasoning|chain of thought/i.test(trimmed),
    toneValid: trimmed.length === 0 || trimmed.length <= 4000,
    suggestedPlane: looksControl && !looksWriting ? 'control-plane' : 'writing-or-general',
  };
}

export function buildDryRunCandidate(prompt, model) {
  return {
    status: 'dry_run',
    latencyMs: 0,
    output: `DRY RUN candidate response for: ${prompt}`,
    model,
  };
}

export function buildReport({
  prompt,
  bridgeConfig = readBridgeConfig(),
  candidateResult,
  referenceResult,
  options = {},
}) {
  const validators = validateOutput({ prompt, candidateOutput: candidateResult?.output || '' });
  const referenceCalled = Boolean(referenceResult && referenceResult.status !== 'skipped');
  const report = {
    id: randomUUID(),
    prompt,
    policy: buildBridgePolicy(parsePolicyArgs(options.rawArgs || [])),
    candidate: {
      model: bridgeConfig.gptossModel,
      outputStored: true,
      status: candidateResult?.status || 'skipped',
      latencyMs: candidateResult?.latencyMs ?? null,
      output: candidateResult?.output || '',
      errorClass: candidateResult?.errorClass || null,
      errorMessage: candidateResult?.errorMessage || null,
      endpoint: bridgeConfig.gptossApiBaseUrl,
    },
    reference: {
      model: bridgeConfig.openaiReferenceModel,
      called: referenceCalled,
      rawOutputStored: false,
      status: referenceResult?.status || 'skipped',
      latencyMs: referenceResult?.latencyMs ?? null,
      errorClass: referenceResult?.errorClass || null,
    },
    validators,
    allowedForTraining: false,
    trainingDecision: 'requires_human_or_spec_label',
  };

  return report;
}

export async function runBridgeEval(options, { fetchImpl = globalThis.fetch } = {}) {
  const bridgeConfig = readBridgeConfig();

  if (options.mode === 'dry-run' || options.noNetwork || !options.allowNetwork) {
    return buildReport({
      prompt: options.prompt,
      bridgeConfig,
      candidateResult: buildDryRunCandidate(options.prompt, bridgeConfig.gptossModel),
      referenceResult: { status: 'skipped', latencyMs: null, errorClass: 'dry_run_no_network' },
      options,
    });
  }

  const candidateResult = await callCandidate({ prompt: options.prompt, config: bridgeConfig, fetchImpl });
  const shouldCallReference = options.callReference && !options.localOnly && options.allowNetwork;
  const referenceResult = shouldCallReference
    ? await callReference({ prompt: options.prompt, config: bridgeConfig, fetchImpl })
    : { status: 'skipped', latencyMs: null, errorClass: 'reference_not_enabled' };

  return buildReport({
    prompt: options.prompt,
    bridgeConfig,
    candidateResult,
    referenceResult,
    options,
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const options = { ...parseArgs(rawArgs), rawArgs };
  const report = await runBridgeEval(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (report.candidate.status === 'error') {
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
