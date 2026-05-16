#!/usr/bin/env node

import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const OPENAI_REFERENCE_MODEL =
  'ft:gpt-4.1-2025-04-14:personal:arcanos:DIbLRZm2';

export const DEFAULT_POLICY = Object.freeze({
  dryRun: true,
  localOnly: true,
  allowNetwork: false,
  enableOpenAiReference: false,
  includeCandidateOutput: true,
  includeReferenceOutput: false,
  openAiRawPersistence: false
});

export function shouldPersistReferenceOutput({ explicitPersist = false } = {}) {
  return {
    allowed: false,
    requested: Boolean(explicitPersist),
    reason: 'OpenAI reference output is evaluate-only and must not be persisted as GPT-OSS training data.'
  };
}

export function buildBridgePolicy(options = {}) {
  const policy = {
    ...DEFAULT_POLICY,
    ...options
  };

  if (policy.enableOpenAiReference && !policy.allowNetwork) {
    return {
      ok: false,
      policy,
      errors: [{
        code: 'openai_reference_requires_network',
        message: 'OpenAI reference calls require both enableOpenAiReference and allowNetwork.'
      }]
    };
  }

  if (policy.openAiRawPersistence) {
    return {
      ok: false,
      policy,
      errors: [{
        code: 'openai_raw_persistence_forbidden',
        message: 'OpenAI raw output persistence is disabled for this bridge.'
      }]
    };
  }

  return {
    ok: true,
    policy,
    errors: []
  };
}

export function parsePolicyArgs(argv = []) {
  const options = {};

  for (const arg of argv) {
    if (arg === '--execute' || arg === '--compare') {
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--allow-network') {
      options.allowNetwork = true;
      options.localOnly = false;
    } else if (arg === '--local-only') {
      options.localOnly = true;
    } else if (arg === '--enable-openai-reference') {
      options.enableOpenAiReference = true;
    } else if (arg === '--call-reference') {
      options.enableOpenAiReference = true;
    } else if (arg === '--omit-candidate-output') {
      options.includeCandidateOutput = false;
    } else if (arg === '--include-reference-output') {
      options.openAiRawPersistence = true;
    }
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const result = buildBridgePolicy(parsePolicyArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
