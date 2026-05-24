#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  evaluateCandidateRecord,
  normalizeCandidateRecord,
} from './db-governance-policy.mjs';
import { redactString, redactValue } from './railway-redaction.mjs';

function parseArgs(argv) {
  const options = {
    execute: false,
    allowDbWrite: false,
    source: undefined,
    input: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--input' && next) {
      options.input = next;
      index += 1;
    } else if (flag === '--source' && next) {
      options.source = next;
      index += 1;
    } else if (flag === '--execute') {
      options.execute = true;
    } else if (flag === '--allow-db-write') {
      options.allowDbWrite = true;
    }
  }

  return options;
}

function readInput(path) {
  if (!path) {
    return {
      id: `candidate-dry-run-${randomUUID()}`,
      source: 'eval_failure_observation',
      redacted: true,
      metadata: { no_openai_output_used: true },
      summary: 'Dry-run candidate placeholder; no raw payload provided.',
    };
  }
  const content = readFileSync(path, 'utf8').trim();
  try {
    return JSON.parse(content);
  } catch {
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

async function insertCandidate(candidate) {
  if (typeof process.env.DATABASE_URL !== 'string' || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error('required_db_connection_env_missing');
  }
  const { Pool } = await import('pg');
  const pool = new Pool();
  try {
    await pool.query(
      `INSERT INTO gptoss_training_candidates (
        candidate_id,
        source,
        reviewed,
        redacted,
        allowed_for_training,
        requires_human_review,
        contains_secret,
        no_openai_output_used,
        raw_input_summary,
        proposed_messages,
        proposed_metadata,
        rejection_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
      ON CONFLICT (candidate_id) DO UPDATE SET
        source = EXCLUDED.source,
        reviewed = EXCLUDED.reviewed,
        redacted = EXCLUDED.redacted,
        allowed_for_training = EXCLUDED.allowed_for_training,
        requires_human_review = EXCLUDED.requires_human_review,
        contains_secret = EXCLUDED.contains_secret,
        no_openai_output_used = EXCLUDED.no_openai_output_used,
        raw_input_summary = EXCLUDED.raw_input_summary,
        proposed_messages = EXCLUDED.proposed_messages,
        proposed_metadata = EXCLUDED.proposed_metadata,
        rejection_reason = EXCLUDED.rejection_reason,
        updated_at = NOW()`,
      [
        candidate.candidate_id,
        candidate.source,
        candidate.reviewed,
        candidate.redacted,
        candidate.allowed_for_training,
        candidate.requires_human_review,
        candidate.contains_secret,
        candidate.no_openai_output_used,
        candidate.raw_input_summary,
        JSON.stringify(candidate.proposed_messages),
        JSON.stringify(candidate.proposed_metadata),
        candidate.rejection_reason,
      ],
    );
  } finally {
    await pool.end();
  }
}

export async function buildCandidateImport(argv = []) {
  const options = parseArgs(argv);
  const input = readInput(options.input);
  const inputs = Array.isArray(input) ? input : [input];
  const candidates = inputs.map((record) => {
    const source = options.source || record.source || 'eval_failure_observation';
    return normalizeCandidateRecord(record, {
      candidateId: record.candidate_id || record.id || `gptoss-candidate-${randomUUID()}`,
      source,
      redacted: record.redacted === true,
    });
  });
  const policies = candidates.map((candidate) => evaluateCandidateRecord(candidate));
  const ok = policies.every((policy) => policy.ok);

  return {
    ok,
    dryRun: !options.execute,
    executeRequested: options.execute,
    dbInsertPlanned: options.execute && options.allowDbWrite && ok,
    candidate: candidates[0],
    policy: policies[0],
    candidates,
    policies,
    checked: candidates.length,
    importable: policies.filter((policy) => policy.ok).length,
    rejected: policies.filter((policy) => !policy.ok).length,
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliExecuted: false,
    liveDbWrite: false,
    options,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await buildCandidateImport(argv);
  if (result.executeRequested && !result.options.allowDbWrite) {
    result.ok = false;
    for (const policy of result.policies) {
      policy.reasons.push('db_write_requires_explicit_allow_flag');
    }
  }

  if (result.ok && result.dbInsertPlanned) {
    for (const candidate of result.candidates) {
      await insertCandidate(candidate);
    }
    result.liveDbWrite = true;
  }

  const output = redactValue({
    ...result,
    options: undefined,
  });
  if (output?.candidate && result?.candidate) {
    output.candidate.contains_secret = result.candidate.contains_secret;
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = output.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'candidate_import_failed',
      message: redactString(error instanceof Error ? error.message : String(error)),
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliExecuted: false,
      liveDbWrite: false,
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
