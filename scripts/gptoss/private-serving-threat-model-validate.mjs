#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { runPrivateServingDesignValidation } from './private-serving-design-validate.mjs';

export const THREAT_MODEL_DOC = 'docs/GPTOSS_PRIVATE_SERVING_THREAT_MODEL.md';

export const REQUIRED_THREATS = [
  'Direct public exposure risk',
  'Prompt injection',
  'Tool escalation',
  'Raw model output leakage',
  'Audit log secret leakage',
  'Replay abuse',
  'Request forgery',
  'Missing rate limits',
  'Accidental training from requests',
  'OpenAI output contamination',
  'Railway command escalation',
  'DB data leakage',
  'Custom GPT direct-to-local exposure',
  'Rollback failure',
];

const REQUIRED_COLUMNS = ['| Threat | Risk | Mitigation | Required gate | Current status |'];

function pushFailure(failures, code, detail = undefined) {
  failures.push(detail ? `${code}:${detail}` : code);
}

export function runPrivateServingThreatModelValidation() {
  const design = runPrivateServingDesignValidation({ write: false });
  const failures = [...design.failures];

  if (!existsSync(THREAT_MODEL_DOC)) {
    pushFailure(failures, 'threat_model_missing', THREAT_MODEL_DOC);
  } else {
    const text = readFileSync(THREAT_MODEL_DOC, 'utf8');
    for (const threat of REQUIRED_THREATS) {
      if (!text.includes(threat)) {
        pushFailure(failures, 'threat_missing', threat);
      }
    }
    for (const column of REQUIRED_COLUMNS) {
      if (!text.includes(column)) {
        pushFailure(failures, 'threat_model_column_missing', column);
      }
    }
    if (!text.includes('cloudReady:false') && !/cloud readiness:\s*blocked/i.test(text)) {
      pushFailure(failures, 'threat_model_cloud_block_missing');
    }
    if (!text.includes('customGptReady:false') && !/Custom GPT readiness:\s*blocked/i.test(text)) {
      pushFailure(failures, 'threat_model_custom_gpt_block_missing');
    }
  }

  return {
    ok: failures.length === 0,
    privateServingDesignReady: design.privateServingDesignReady,
    replayProtectionDurableDesigned: design.replayProtectionDurableDesigned === true,
    replayProtectionDurableImplemented: false,
    replayProtectionDurable: false,
    privateServingImplemented: false,
    privateServingExposed: false,
    cloudReady: false,
    customGptReady: false,
    publicServerCreated: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    noOpenAiOutputUsed: true,
    failures,
    docs: [THREAT_MODEL_DOC],
  };
}

function main() {
  const report = runPrivateServingThreatModelValidation();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
