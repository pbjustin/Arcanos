import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const policyPath = join(process.cwd(), 'scripts', 'gptoss', 'db-governance-policy.mjs');
const schemaPath = join(process.cwd(), 'scripts', 'gptoss', 'db-governance-schema.mjs');
const candidatePath = join(process.cwd(), 'scripts', 'gptoss', 'db-training-candidate-import.mjs');
const exportPath = join(process.cwd(), 'scripts', 'gptoss', 'db-export-approved-training.mjs');
const ledgerPath = join(process.cwd(), 'scripts', 'gptoss', 'db-eval-ledger.mjs');
const classificationPath = join(process.cwd(), 'scripts', 'gptoss', 'db-classification-inspect.mjs');
const migrationPath = join(process.cwd(), 'migrations', '20260521_gptoss_governance.sql');

async function loadPolicyModule() {
  return import(pathToFileURL(policyPath).href);
}

async function loadSchemaModule() {
  return import(pathToFileURL(schemaPath).href);
}

async function loadCandidateModule() {
  return import(pathToFileURL(candidatePath).href);
}

async function loadExportModule() {
  return import(pathToFileURL(exportPath).href);
}

async function loadLedgerModule() {
  return import(pathToFileURL(ledgerPath).href);
}

async function loadClassificationModule() {
  return import(pathToFileURL(classificationPath).href);
}

function approvedRecord(overrides = {}) {
  return {
    example_id: 'approved-1',
    source: 'human_authored',
    reviewed: true,
    redacted: true,
    allowed_for_training: true,
    no_openai_output_used: true,
    target_shape: 'json_only',
    task_type: 'db_governance_test',
    messages: [
      { role: 'system', content: 'Return JSON only.' },
      { role: 'user', content: 'Validate the local dataset.' },
      { role: 'assistant', content: '{"action":"validate_dataset","allowedForTraining":false}' },
    ],
    metadata: {
      target_shape: 'json_only',
      no_openai_output_used: true,
    },
    ...overrides,
  };
}

describe('gptoss DB governance layer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'arcanos-gptoss-db-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('validates the governance migration without connecting to a live DB', async () => {
    const schema = await loadSchemaModule() as {
      validateGovernanceSchema: (input?: unknown) => unknown;
    };
    const result = schema.validateGovernanceSchema({ path: migrationPath }) as {
      ok?: boolean;
      liveDbConnected?: boolean;
      tables?: string[];
      indexes?: string[];
    };

    expect(result.ok).toBe(true);
    expect(result.liveDbConnected).toBe(false);
    expect(result.tables).toEqual(expect.arrayContaining([
      'arcanos_action_registry',
      'arcanos_route_policy',
      'arcanos_safety_rules',
      'gptoss_eval_runs',
      'gptoss_eval_failures',
      'gptoss_training_candidates',
      'gptoss_approved_training_examples',
    ]));
    expect(result.indexes?.length).toBeGreaterThanOrEqual(10);
  });

  it('fails closed for live schema apply when the required DB connection env is missing', () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const result = spawnSync(process.execPath, [schemaPath, '--execute', '--allow-db-write'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env,
    });
    const parsed = JSON.parse(result.stdout);

    expect(result.status).not.toBe(0);
    expect(parsed).toMatchObject({
      ok: false,
      error: 'governance_schema_failed',
      message: 'required_db_connection_env_missing',
      migrationApplied: false,
      liveDbWrite: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliExecuted: false,
    });
  });

  it('enforces source and review policy for approved training examples', async () => {
    const policy = await loadPolicyModule() as {
      evaluateApprovedTrainingExample: (input: unknown) => { ok: boolean; reasons: string[] };
    };

    expect(policy.evaluateApprovedTrainingExample(approvedRecord()).ok).toBe(true);
    expect(policy.evaluateApprovedTrainingExample(approvedRecord({ source: 'openai_output' })).reasons).toContain('openai_derived_source_rejected');
    expect(policy.evaluateApprovedTrainingExample(approvedRecord({ source: 'railway_cli_observation', allowed_for_training: false })).reasons).toContain('source_rejected:railway_cli_observation');
    expect(policy.evaluateApprovedTrainingExample(approvedRecord({ source: 'eval_failure_observation', allowed_for_training: false, reviewed: false })).reasons).toContain('source_rejected:eval_failure_observation');
    expect(policy.evaluateApprovedTrainingExample(approvedRecord({ source: 'self_reflection_observation', allowed_for_training: false, reviewed: false })).reasons).toContain('source_rejected:self_reflection_observation');
    expect(policy.evaluateApprovedTrainingExample(approvedRecord({ reviewed: false })).reasons).toContain('reviewed_true_required');
    expect(policy.evaluateApprovedTrainingExample(approvedRecord({ source: 'arcanos_owned_spec', reviewed: true })).ok).toBe(true);
    expect(policy.evaluateApprovedTrainingExample(approvedRecord({ contains_secret: true })).reasons).toContain('contains_secret');
  });

  it('defaults imported candidates to unreviewed, human-review-required, and not trainable', async () => {
    const candidateModule = await loadCandidateModule() as {
      buildCandidateImport: (argv: string[]) => Promise<unknown>;
    };
    const inputPath = join(tempDir, 'candidate.json');
    writeFileSync(inputPath, JSON.stringify({
      id: 'candidate-1',
      source: 'railway_cli_observation',
      redacted: true,
      openAiCalled: false,
      result: {
        stdoutPreview: 'redacted observation summary',
      },
    }), 'utf8');

    const result = await candidateModule.buildCandidateImport(['--input', inputPath]) as {
      ok?: boolean;
      dryRun?: boolean;
      candidate?: {
        allowed_for_training?: boolean;
        reviewed?: boolean;
        requires_human_review?: boolean;
        source?: string;
      };
      trainingExecuted?: boolean;
      vllmUsed?: boolean;
      railwayCliExecuted?: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.candidate).toMatchObject({
      source: 'railway_cli_observation',
      allowed_for_training: false,
      reviewed: false,
      requires_human_review: true,
    });
    expect(result.trainingExecuted).toBe(false);
    expect(result.vllmUsed).toBe(false);
    expect(result.railwayCliExecuted).toBe(false);
  });

  it('dry-runs eval failure candidate JSONL batches as non-trainable governance drafts', async () => {
    const candidateModule = await loadCandidateModule() as {
      buildCandidateImport: (argv: string[]) => Promise<unknown>;
    };
    const inputPath = join(tempDir, 'phase38-candidates.jsonl');
    writeFileSync(inputPath, [
      JSON.stringify({
        candidate_id: 'phase3-8-candidate-a',
        source: 'eval_failure_observation',
        reviewed: false,
        redacted: true,
        allowed_for_training: false,
        requires_human_review: true,
        no_openai_output_used: true,
        contains_secret: false,
        eval_id: 'eval-smoke-002',
        raw_input_summary: 'Protocol owner prompt.',
        observed_summary: 'Wrong owner summary.',
      }),
      JSON.stringify({
        candidate_id: 'phase3-8-candidate-b',
        source: 'eval_failure_observation',
        reviewed: false,
        redacted: true,
        allowed_for_training: false,
        requires_human_review: true,
        no_openai_output_used: true,
        contains_secret: false,
        eval_id: 'eval-smoke-020',
        raw_input_summary: 'Route label prompt.',
        observed_summary: 'Wrong route summary.',
      }),
    ].join('\n') + '\n', 'utf8');

    const result = await candidateModule.buildCandidateImport(['--input', inputPath]) as {
      ok?: boolean;
      dryRun?: boolean;
      checked?: number;
      importable?: number;
      rejected?: number;
      candidates?: Array<{
        source?: string;
        reviewed?: boolean;
        allowed_for_training?: boolean;
        requires_human_review?: boolean;
      }>;
      openAiCalled?: boolean;
      trainingExecuted?: boolean;
      vllmUsed?: boolean;
      railwayCliExecuted?: boolean;
      liveDbWrite?: boolean;
    };

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.importable).toBe(2);
    expect(result.rejected).toBe(0);
    expect(result.candidates?.every((candidate) => candidate.source === 'eval_failure_observation')).toBe(true);
    expect(result.candidates?.every((candidate) => candidate.reviewed === false)).toBe(true);
    expect(result.candidates?.every((candidate) => candidate.allowed_for_training === false)).toBe(true);
    expect(result.candidates?.every((candidate) => candidate.requires_human_review === true)).toBe(true);
    expect(result.openAiCalled).toBe(false);
    expect(result.trainingExecuted).toBe(false);
    expect(result.vllmUsed).toBe(false);
    expect(result.railwayCliExecuted).toBe(false);
    expect(result.liveDbWrite).toBe(false);
  });

  it('exports only approved rows and rejects candidate-only provenance', async () => {
    const exportModule = await loadExportModule() as {
      buildApprovedExport: (argv: string[]) => Promise<unknown>;
    };
    const inputPath = join(tempDir, 'rows.json');
    writeFileSync(inputPath, JSON.stringify([
      approvedRecord(),
      approvedRecord({
        example_id: 'candidate-only',
        source: 'railway_cli_observation',
        reviewed: false,
        redacted: true,
        allowed_for_training: false,
      }),
    ]), 'utf8');

    const result = await exportModule.buildApprovedExport(['--input', inputPath]) as {
      ok?: boolean;
      checked?: number;
      exportable?: number;
      rejected?: number;
      validations?: Array<{ ok: boolean; policy: { reasons: string[] } }>;
      openAiCalled?: boolean;
    };

    expect(result.ok).toBe(false);
    expect(result.checked).toBe(2);
    expect(result.exportable).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.validations?.[1].policy.reasons).toContain('source_rejected:railway_cli_observation');
    expect(result.openAiCalled).toBe(false);
  });

  it('runs the dataset gate against approved export rows', async () => {
    const exportModule = await loadExportModule() as {
      buildApprovedExport: (argv: string[]) => Promise<unknown>;
    };
    const inputPath = join(tempDir, 'invalid-row.json');
    writeFileSync(inputPath, JSON.stringify([
      approvedRecord({
        example_id: 'invalid-json-target',
        messages: [
          { role: 'system', content: 'Return JSON only.' },
          { role: 'user', content: 'Validate the local dataset.' },
          { role: 'assistant', content: '{not-json}' },
        ],
      }),
    ]), 'utf8');

    const result = await exportModule.buildApprovedExport(['--input', inputPath]) as {
      ok?: boolean;
      validations?: Array<{ errors: Array<{ code: string }> }>;
    };

    expect(result.ok).toBe(false);
    expect(result.validations?.[0].errors).toContainEqual({ line: 1, code: 'json_assistant_target_invalid' });
  });

  it('ingests eval reports into run and failure ledger records without creating training examples', async () => {
    const ledgerModule = await loadLedgerModule() as {
      buildEvalLedger: (report: unknown, options?: unknown) => unknown;
    };
    const evalFile = join(tempDir, 'eval.jsonl');
    writeFileSync(evalFile, `${JSON.stringify({
      id: 'eval-1',
      prompt: 'Return a dataset validation action.',
      expected: {
        json_object: true,
        must_include: ['validate_dataset'],
      },
    })}\n`, 'utf8');

    const ledger = ledgerModule.buildEvalLedger({
      adapterDir: 'local_artifacts/gptoss-test-adapter',
      evalFile,
      passed: 0,
      failed: 1,
      forceFinalChannel: true,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      noOpenAiOutputUsed: true,
      failures: [
        {
          id: 'eval-1',
          expected: { json_object: true, must_include: ['validate_dataset'] },
          finalText: '{"action":"status"}',
          validJson: true,
        },
      ],
    }, { report: join(tempDir, 'report.json'), evalFile }) as {
      run?: { failed_count?: number; force_final_channel?: boolean };
      failures?: Array<{ failure_reasons?: string[]; suggested_repair_target?: string }>;
      trainingExamplesCreated?: number;
      allowedForTraining?: boolean;
    };

    expect(ledger.run).toMatchObject({
      failed_count: 1,
      force_final_channel: true,
    });
    expect(ledger.failures?.[0].failure_reasons).toContain('missing:validate_dataset');
    expect(ledger.failures?.[0].suggested_repair_target).toBe('validate_dataset');
    expect(ledger.trainingExamplesCreated).toBe(0);
    expect(ledger.allowedForTraining).toBe(false);
  });

  it('keeps eval failure observations rejected by the dataset gate', () => {
    const datasetGatePath = join(process.cwd(), 'scripts', 'gptoss', 'dataset-gate.mjs');
    const datasetPath = join(tempDir, 'dataset.jsonl');
    writeFileSync(datasetPath, `${JSON.stringify({
      source: 'eval_failure_observation',
      reviewed: false,
      allowed_for_training: false,
      text: 'redacted eval failure summary',
      metadata: {
        target_shape: 'compact_final',
        no_openai_output_used: true,
      },
    })}\n`, 'utf8');

    const result = spawnSync(process.execPath, [datasetGatePath, datasetPath], { encoding: 'utf8' });
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(parsed.errors).toContainEqual({ line: 1, code: 'rejected_source', source: 'eval_failure_observation' });
  });

  it('keeps self-reflection observations rejected by the dataset gate', () => {
    const datasetGatePath = join(process.cwd(), 'scripts', 'gptoss', 'dataset-gate.mjs');
    const datasetPath = join(tempDir, 'dataset.jsonl');
    writeFileSync(datasetPath, `${JSON.stringify({
      source: 'self_reflection_observation',
      reviewed: false,
      allowed_for_training: false,
      text: 'redacted self-reflection summary',
      metadata: {
        target_shape: 'compact_final',
        no_openai_output_used: true,
      },
    })}\n`, 'utf8');

    const result = spawnSync(process.execPath, [datasetGatePath, datasetPath], { encoding: 'utf8' });
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(parsed.errors).toContainEqual({ line: 1, code: 'rejected_source', source: 'self_reflection_observation' });
  });

  it('builds classification reports from schema and key counts only', async () => {
    const classification = await loadClassificationModule() as {
      buildClassificationInspection: (input?: unknown) => Promise<{
        selfReflectionsTableExists?: boolean;
        selfReflectionHasCategoryPriority?: boolean;
        selfReflectionRowCount?: number | null;
        datasetTablesFound?: Array<{ tableName: string; columns: string[] }>;
        datasetClassificationFieldsFound?: Record<string, string[]>;
        missingClassificationFields?: Record<string, string[]>;
        metadataKeys?: unknown[];
        rawContentDumped?: boolean;
        rawRowsDumped?: boolean;
        openAiCalled?: boolean;
        trainingExecuted?: boolean;
        vllmUsed?: boolean;
      }>;
      buildSelfReflectionCandidateMappingPlan: (input?: unknown) => {
        candidateDefaults?: Record<string, unknown>;
        metadataValuesIncluded?: boolean;
        metadataValuePolicy?: string;
        allowedForTraining?: boolean;
      };
    };

    const report = await classification.buildClassificationInspection();
    const mapping = classification.buildSelfReflectionCandidateMappingPlan({
      metadataKeys: [{ key: 'source_component', count: 3 }],
    });

    expect(report.selfReflectionsTableExists).toBe(true);
    expect(report.selfReflectionHasCategoryPriority).toBe(true);
    expect(report.selfReflectionRowCount).toBeNull();
    expect(report.datasetTablesFound?.map((table) => table.tableName)).toContain('gptoss_training_candidates');
    expect(report.datasetClassificationFieldsFound?.gptoss_training_candidates).toEqual(expect.arrayContaining([
      'source',
      'reviewed',
      'allowed_for_training',
      'requires_human_review',
      'no_openai_output_used',
    ]));
    expect(report.missingClassificationFields?.self_reflections).toEqual(expect.arrayContaining([
      'source',
      'allowed_for_training',
      'requires_human_review',
    ]));
    expect(report.metadataKeys).toEqual([]);
    expect(report.rawContentDumped).toBe(false);
    expect(report.rawRowsDumped).toBe(false);
    expect(report.openAiCalled).toBe(false);
    expect(report.trainingExecuted).toBe(false);
    expect(report.vllmUsed).toBe(false);

    expect(mapping.candidateDefaults).toMatchObject({
      source: 'self_reflection_observation',
      reviewed: false,
      allowed_for_training: false,
      requires_human_review: true,
    });
    expect(mapping.metadataValuesIncluded).toBe(false);
    expect(mapping.metadataValuePolicy).toBe('keys_only_values_never_exported');
    expect(mapping.allowedForTraining).toBe(false);
  });

  it('writes classification reports without dumping raw values', () => {
    const reportPath = join(tempDir, 'classification-report.json');
    const mappingPath = join(tempDir, 'mapping-report.json');
    const result = spawnSync(process.execPath, [
      classificationPath,
      '--report',
      reportPath,
      '--mapping-report',
      mappingPath,
    ], { encoding: 'utf8' });

    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));

    expect(result.status).toBe(0);
    expect(report.rawContentDumped).toBe(false);
    expect(report.rawRowsDumped).toBe(false);
    expect(report.trainingJsonlExported).toBe(false);
    expect(mapping.metadataValuesIncluded).toBe(false);
    expect(JSON.stringify(report)).not.toContain('DATABASE_URL');
    expect(JSON.stringify(mapping)).not.toContain('DATABASE_URL');
  });

  it('keeps classification inspection metadata-only and offline by default', () => {
    const source = readFileSync(classificationPath, 'utf8');

    expect(source).toContain('jsonb_object_keys(metadata)');
    expect(source).not.toMatch(/SELECT\s+content\b/i);
    expect(source).not.toMatch(/SELECT\s+\*/i);
    expect(source).not.toMatch(/\bCOPY\b/i);
    expect(source).not.toMatch(/\bpg_dump\b/i);
    expect(source).not.toContain('api.openai.com');
    expect(source).not.toContain('openAiCalled: true');
    expect(source).not.toContain('trainer.train');
    expect(source).not.toContain('model.generate');
    expect(source).not.toMatch(/\bvllm\s+serve\b|from ['"]vllm/i);
    expect(source).not.toContain("execFile('railway'");
  });

  it('does not print configured secret values in dry-run command outputs', () => {
    const env = {
      ...process.env,
      RAILWAY_TOKEN: 'rwy_abcdefghijklmnopqrstuvwxyz123456',
      OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    };
    for (const [script, args] of [
      [schemaPath, ['--dry-run']],
      [candidatePath, []],
      [exportPath, []],
      [ledgerPath, []],
      [classificationPath, []],
    ] as const) {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env,
      });
      expect(result.stdout).not.toContain('rwy_abcdefghijklmnopqrstuvwxyz123456');
      expect(result.stdout).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
      expect(result.stdout).toContain('"openAiCalled": false');
      expect(result.stdout).toContain('"trainingExecuted": false');
      expect(result.stdout).toContain('"vllmUsed": false');
    }
  });

  it('does not introduce live Railway, OpenAI, vLLM, or training execution paths in DB scripts', () => {
    for (const script of [candidatePath, exportPath, ledgerPath, classificationPath]) {
      const source = readFileSync(script, 'utf8');
      expect(source).not.toContain('runRailwayBridge');
      expect(source).not.toContain("execFile('railway'");
      expect(source).not.toContain('openAiCalled: true');
      expect(source).not.toContain('trainingExecuted: true');
      expect(source).not.toContain('vllmUsed: true');
    }
  });
});
