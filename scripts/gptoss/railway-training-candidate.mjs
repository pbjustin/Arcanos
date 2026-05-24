#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { parseArgs as parseBridgeArgs, runRailwayBridge } from './railway-cli-bridge.mjs';
import { redactString, redactValue } from './railway-redaction.mjs';

const MAX_OBSERVATION_CHARS = 3_000;

function compactObservation(observation) {
  const text = JSON.stringify(redactValue(observation));
  if (text.length <= MAX_OBSERVATION_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OBSERVATION_CHARS)}...[truncated]`;
}

export function buildRailwayTrainingCandidate(observation, { id = `railway-candidate-${randomUUID()}` } = {}) {
  const redactedObservation = redactValue(observation);
  const action = redactedObservation?.action || 'railway.unknown';

  return redactValue({
    id,
    source: 'railway_cli_observation',
    reviewed: false,
    allowed_for_training: false,
    task_type: 'railway_diagnostic_observation',
    metadata: {
      redacted: true,
      requires_human_review: true,
      no_openai_output_used: true,
      not_raw_training_label: true,
      target_shape: 'compact_final',
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
    },
    messages: [
      {
        role: 'system',
        content: 'You are Arcanos. Treat Railway operations as controlled backend diagnostics.',
      },
      {
        role: 'developer',
        content: 'Classify Railway requests into safe actions. Do not expose secrets.',
      },
      {
        role: 'user',
        content: `Review this redacted Railway CLI observation for safe protocol drafting: ${compactObservation(redactedObservation)}`,
      },
      {
        role: 'assistant',
        content: `UNREVIEWED_DRAFT_NOT_A_TRAINING_LABEL for ${redactString(action)}`,
      },
    ],
  });
}

function parseCandidateArgs(argv = []) {
  const options = {
    bridgeArgs: [],
    dryRun: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];

    if (flag === '--input' && next) {
      options.input = next;
      index += 1;
    } else if (flag === '--execute') {
      throw new Error('--execute is not supported for training-candidate drafts');
    } else {
      options.bridgeArgs.push(flag);
      if (next && !next.startsWith('--')) {
        options.bridgeArgs.push(next);
        index += 1;
      }
    }
  }

  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseCandidateArgs(argv);
  const observation = options.input
    ? JSON.parse(readFileSync(options.input, 'utf8'))
    : await runRailwayBridge({
      action: 'railway.whoami',
      ...parseBridgeArgs(options.bridgeArgs),
      dryRun: true,
      execute: false,
    });

  const candidate = buildRailwayTrainingCandidate(observation);
  process.stdout.write(`${JSON.stringify(candidate)}\n`);
  process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'candidate_failed',
      message: redactString(error instanceof Error ? error.message : String(error)),
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
    })}\n`);
    process.exitCode = 2;
  });
}
