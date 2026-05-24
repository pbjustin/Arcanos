import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const datasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-railway-safe-routing.jsonl');
const validatorPath = join(process.cwd(), 'scripts', 'gptoss', 'validate-railway-safe-routing-dataset.mjs');
const gatePath = join(process.cwd(), 'scripts', 'gptoss', 'dataset-gate.mjs');
const packageJsonPath = join(process.cwd(), 'package.json');
const readonlyActions = new Set([
  'railway.whoami',
  'railway.status',
  'railway.logs',
  'railway.variables.list',
  'railway.environment',
  'railway.service',
]);
const privilegedActions = new Set([
  'railway.restart',
  'railway.redeploy',
  'railway.up',
  'railway.variable.set',
  'railway.down',
  'railway.ssh',
  'railway.shell',
  'railway.delete',
  'railway.scale',
]);

function readRows() {
  return readFileSync(datasetPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

function assistantTarget(row) {
  return JSON.parse(row.messages.find((message) => message.role === 'assistant').content);
}

function runDatasetGate(lines: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-railway-safe-routing-'));
  const tempDataset = join(tempDir, 'dataset.jsonl');
  writeFileSync(tempDataset, `${lines.join('\n')}\n`, 'utf8');

  try {
    const completed = spawnSync(process.execPath, [gatePath, tempDataset], { encoding: 'utf8' });
    return {
      status: completed.status,
      parsed: JSON.parse(completed.stdout),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runRailwayValidator(lines: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-railway-safe-validator-'));
  const tempDataset = join(tempDir, 'dataset.jsonl');
  writeFileSync(tempDataset, `${lines.join('\n')}\n`, 'utf8');

  try {
    const completed = spawnSync(process.execPath, [validatorPath, tempDataset], { encoding: 'utf8' });
    return {
      status: completed.status,
      parsed: JSON.parse(completed.stdout),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('gptoss railway-safe routing dataset', () => {
  it('validates with the dedicated Railway-safe dataset validator', () => {
    const completed = spawnSync(process.execPath, [validatorPath], { encoding: 'utf8' });
    const parsed = JSON.parse(completed.stdout);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
    expect(parsed).toMatchObject({
      ok: true,
      file: 'examples/gptoss/arcanos-railway-safe-routing.jsonl',
      checked: 20,
      accepted: 20,
      rejected: 0,
      errors: [],
      gate: {
        ok: true,
        checked: 20,
        accepted: 20,
        rejected: 0,
        errors: [],
      },
    });
  });

  it('uses only spec-authored message records with JSON-only assistant targets', () => {
    const rows = readRows();

    expect(rows).toHaveLength(20);
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'arcanos_owned_spec',
        reviewed: true,
        allowed_for_training: true,
        task_type: 'railway_safe_routing',
        metadata: {
          no_openai_output_used: true,
          target_shape: 'json_only',
          railway_bridge_policy: true,
          raw_railway_output_used: false,
        },
      });
      expect(row).not.toHaveProperty('text');
      expect(row.messages.map((message) => message.role)).toEqual([
        'system',
        'developer',
        'user',
        'assistant',
      ]);
      expect(() => assistantTarget(row)).not.toThrow();
      expect(row.messages.find((message) => message.role === 'assistant').content).not.toMatch(
        /Input:|Expected:|Analysis:|Reasoning:|chain of thought|<\|channel\|>/i
      );
    }
  });

  it('marks read-only and privileged examples with the expected policy shape', () => {
    const targets = readRows().map(assistantTarget);
    const readonlyTargets = targets.filter((target) => readonlyActions.has(target.action));
    const privilegedTargets = targets.filter((target) => privilegedActions.has(target.action));

    expect(readonlyTargets).toHaveLength(8);
    expect(privilegedTargets).toHaveLength(8);
    expect(readonlyTargets.every((target) => (
      target.risk === 'readonly' &&
      target.requiresConfirmation === false &&
      target.allowedForTraining === false
    ))).toBe(true);
    expect(privilegedTargets.every((target) => (
      target.risk === 'privileged' &&
      target.requiresConfirmation === true &&
      target.blockedByDefault === true &&
      target.allowedForTraining === false
    ))).toBe(true);
  });

  it('routes secret, raw-log training, and unknown action requests to reject actions', () => {
    const targetsById = new Map(readRows().map((row) => [row.id, assistantTarget(row)]));

    expect(targetsById.get('railway-safe-raw-log-training-017')).toMatchObject({
      action: 'reject_training_from_raw_logs',
      risk: 'data_governance',
      requiresConfirmation: false,
      allowedForTraining: false,
    });
    expect(targetsById.get('railway-safe-secret-print-018')).toMatchObject({
      action: 'reject',
      risk: 'secret_exposure',
      requiresConfirmation: false,
      allowedForTraining: false,
    });
    expect(targetsById.get('railway-safe-token-print-019')).toMatchObject({
      action: 'reject',
      risk: 'secret_exposure',
      requiresConfirmation: false,
      allowedForTraining: false,
    });
    expect(targetsById.get('railway-safe-unknown-020')).toMatchObject({
      action: 'reject_unknown_action',
      risk: 'unknown',
      requiresConfirmation: false,
      allowedForTraining: false,
    });
  });

  it('keeps railway_cli_observation, raw logs, and secrets rejected by the dataset gate', () => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'railway_cli_observation',
        reviewed: false,
        allowed_for_training: false,
        text: 'redacted observation draft',
        metadata: { target_shape: 'compact_final', no_openai_output_used: true },
      }),
      JSON.stringify({
        source: 'human_authored',
        reviewed: true,
        allowed_for_training: true,
        text: '2026-05-16T12:00:00Z ERROR raw diagnostic line',
        metadata: { target_shape: 'compact_final', no_openai_output_used: true },
      }),
      JSON.stringify({
        source: 'human_authored',
        reviewed: true,
        allowed_for_training: true,
        text: 'token=[redacted]',
        metadata: { target_shape: 'compact_final', no_openai_output_used: true },
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'rejected_source', source: 'railway_cli_observation' },
      { line: 2, code: 'raw_log_marker' },
      { line: 3, code: 'secret_marker' },
    ]);
  });

  it('rejects Railway-safe rows with raw-output metadata, prose targets, or channel JSON', () => {
    const baseRow = readRows()[0];
    const rawOutputRow = {
      ...baseRow,
      id: 'bad-raw-output',
      metadata: { ...baseRow.metadata, raw_railway_output_used: true },
    };
    const proseTargetRow = {
      ...baseRow,
      id: 'bad-prose-target',
      messages: baseRow.messages.map((message) => (
        message.role === 'assistant'
          ? { ...message, content: 'Analysis: not JSON' }
          : message
      )),
    };
    const channelTargetRow = {
      ...baseRow,
      id: 'bad-channel-target',
      messages: baseRow.messages.map((message) => (
        message.role === 'assistant'
          ? { ...message, content: '{"channel":"final","action":"railway.status"}' }
          : message
      )),
    };

    const result = runRailwayValidator([
      JSON.stringify(rawOutputRow),
      JSON.stringify(proseTargetRow),
      JSON.stringify(channelTargetRow),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual(expect.arrayContaining([
      { line: 1, code: 'railway_dataset_raw_output_forbidden' },
      { line: 2, code: 'assistant_target_not_final_only' },
      { line: 2, code: 'railway_dataset_forbidden_text' },
      { line: 2, code: 'railway_dataset_assistant_json_required' },
      { line: 3, code: 'railway_dataset_forbidden_text' },
    ]));
  });

  it('does not wire validation into OpenAI, live Railway CLI, vLLM, or training scripts', async () => {
    const validatorSource = readFileSync(validatorPath, 'utf8');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const validatorModule = await import(pathToFileURL(validatorPath).href) as {
      validateRailwaySafeRoutingDataset: (filePath?: string) => unknown;
    };

    expect(validatorSource).not.toContain('railway-cli-bridge');
    expect(validatorSource).not.toContain('execFile');
    expect(validatorSource).not.toContain('spawn(');
    expect(validatorSource).not.toContain('vllm');
    expect(validatorSource).not.toContain('model-clients');
    expect(packageJson.scripts['gptoss:railway:dataset:validate']).toBe(
      'node scripts/gptoss/validate-railway-safe-routing-dataset.mjs'
    );
    expect(Object.keys(packageJson.scripts).filter((name) => (
      name.includes('railway:dataset') && /train|unsloth|execute/.test(name)
    ))).toEqual([]);
    expect(validatorModule.validateRailwaySafeRoutingDataset()).toMatchObject({ ok: true });
  });
});
