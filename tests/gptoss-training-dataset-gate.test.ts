import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = join(process.cwd(), 'scripts', 'gptoss', 'dataset-gate.mjs');
const validateDatasetScriptPath = join(process.cwd(), 'scripts', 'gptoss', 'validate-training-dataset.mjs');
const validatePhase36DatasetScriptPath = join(process.cwd(), 'scripts', 'gptoss', 'validate-phase3-6-dataset.mjs');
const validatePhase37DatasetScriptPath = join(process.cwd(), 'scripts', 'gptoss', 'validate-phase3-7-dataset.mjs');
const validatePhase38DatasetScriptPath = join(process.cwd(), 'scripts', 'gptoss', 'validate-phase3-8-dataset.mjs');
const phase34DatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-phase3-4-training.jsonl');
const phase35DatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-phase3-5-target-shape-training.jsonl');
const phase36DatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-phase3-6-action-label-training.jsonl');
const phase37DatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-phase3-7-weighted-repair-training.jsonl');
const phase38DatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-phase3-8-true-error-repair-training.jsonl');
const microDatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-micro-overfit-training.jsonl');
const singleJsonDatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-single-json-overfit-training.jsonl');
const singleSafetyDatasetPath = join(process.cwd(), 'examples', 'gptoss', 'arcanos-single-safety-overfit-training.jsonl');
const trainingSchemaPath = join(process.cwd(), 'schemas', 'gptoss-training-record.schema.json');
const trainingMetadata = { target_shape: 'compact_final', no_openai_output_used: true };

function runDatasetGate(lines: string[]) {
  const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-gptoss-dataset-'));
  const datasetPath = join(tempDir, 'dataset.jsonl');
  writeFileSync(datasetPath, `${lines.join('\n')}\n`, 'utf8');

  try {
    const completed = spawnSync(process.execPath, [scriptPath, datasetPath], {
      encoding: 'utf8',
    });

    return {
      status: completed.status,
      stderr: completed.stderr,
      stdout: completed.stdout,
      parsed: JSON.parse(completed.stdout),
      datasetPath,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('gptoss training dataset gate', () => {
  it('validates the phase3.4 targeted training fixture', () => {
    const completed = spawnSync(process.execPath, [validateDatasetScriptPath, phase34DatasetPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(completed.stdout);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
    expect(parsed).toMatchObject({
      ok: true,
      checked: 80,
      accepted: 80,
      rejected: 0,
      errors: [],
    });

    const rows = readFileSync(phase34DatasetPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const newRows = rows.filter((row) => String(row.id).startsWith('phase3-4-'));
    expect(newRows).toHaveLength(40);
    expect(newRows.every((row) => Array.isArray(row.messages) && !('text' in row))).toBe(true);
    expect(newRows.every((row) => row.metadata?.no_openai_output_used === true)).toBe(true);
    expect(newRows.every((row) => ['label_only', 'json_only', 'compact_final'].includes(row.metadata?.target_shape))).toBe(true);
    expect(newRows.every((row) => row.messages.filter((message) => message.role === 'assistant').length === 1)).toBe(true);
    for (const row of newRows.filter((row) => row.metadata.target_shape === 'json_only')) {
      JSON.parse(row.messages.find((message) => message.role === 'assistant').content);
    }
  });

  it('validates the phase3.5 target-shape training fixture', () => {
    const completed = spawnSync(process.execPath, [validateDatasetScriptPath, phase35DatasetPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(completed.stdout);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
    expect(parsed).toMatchObject({
      ok: true,
      checked: 120,
      accepted: 120,
      rejected: 0,
      errors: [],
    });

    const rows = readFileSync(phase35DatasetPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const newRows = rows.filter((row) => String(row.id).startsWith('phase3-5-'));
    expect(rows).toHaveLength(120);
    expect(newRows).toHaveLength(40);
    expect(newRows.every((row) => row.source !== 'railway_cli_observation')).toBe(true);
    expect(newRows.every((row) => Array.isArray(row.messages) && !('text' in row))).toBe(true);
    expect(newRows.every((row) => row.metadata?.no_openai_output_used === true)).toBe(true);
    expect(newRows.every((row) => ['label_only', 'json_only', 'compact_final'].includes(row.metadata?.target_shape))).toBe(true);
    expect(newRows.every((row) => row.messages.filter((message) => message.role === 'assistant').length === 1)).toBe(true);

    const assistantTargets = newRows.map((row) => row.messages.find((message) => message.role === 'assistant').content);
    for (const row of newRows.filter((row) => row.metadata.target_shape === 'json_only')) {
      JSON.parse(row.messages.find((message) => message.role === 'assistant').content);
    }
    for (const row of newRows.filter((row) => row.metadata.target_shape === 'label_only')) {
      const target = row.messages.find((message) => message.role === 'assistant').content;
      expect(target).toMatch(/^\S{1,64}$/);
    }
    for (const expectedAction of ['railway.logs', 'railway.status', 'validate_dataset', 'reject', 'reject_training_from_raw_logs']) {
      expect(assistantTargets.some((target) => target.includes(expectedAction))).toBe(true);
    }
  });

  it('validates the phase3.6 action-label disambiguation training fixture', () => {
    const completed = spawnSync(process.execPath, [validatePhase36DatasetScriptPath, phase36DatasetPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(completed.stdout);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
    expect(parsed).toMatchObject({
      ok: true,
      checked: 152,
      accepted: 152,
      rejected: 0,
      errors: [],
    });

    const rows = readFileSync(phase36DatasetPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const newRows = rows.filter((row) => String(row.id).startsWith('phase3-6-'));
    expect(rows).toHaveLength(152);
    expect(newRows).toHaveLength(32);
    expect(newRows.every((row) => row.source !== 'railway_cli_observation')).toBe(true);
    expect(newRows.every((row) => !['openai_output', 'openai_judgment'].includes(row.source))).toBe(true);
    expect(newRows.every((row) => Array.isArray(row.messages) && !('text' in row))).toBe(true);
    expect(newRows.every((row) => row.metadata?.no_openai_output_used === true)).toBe(true);
    expect(newRows.every((row) => ['label_only', 'json_only', 'compact_final'].includes(row.metadata?.target_shape))).toBe(true);
    expect(newRows.every((row) => row.messages.filter((message) => message.role === 'assistant').length === 1)).toBe(true);

    const assistantTargets = newRows.map((row) => row.messages.find((message) => message.role === 'assistant').content);
    const labelTargets = newRows
      .filter((row) => row.metadata.target_shape === 'label_only')
      .map((row) => row.messages.find((message) => message.role === 'assistant').content);

    expect(assistantTargets.some((target) => target.includes('validate_dataset'))).toBe(true);
    expect(labelTargets).toContain('control-plane');
    expect(labelTargets).toContain('writing-plane');

    for (const row of newRows.filter((row) => row.metadata.target_shape === 'json_only')) {
      JSON.parse(row.messages.find((message) => message.role === 'assistant').content);
    }
    for (const target of labelTargets) {
      expect(target).toMatch(/^\S{1,64}$/);
      expect(target).not.toMatch(/[{}[\]:,]/);
    }

    const packageScripts = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).scripts;
    expect(packageScripts['gptoss:unsloth:phase3-8:lowlr:dry']).not.toContain('--execute');
    expect(packageScripts['gptoss:unsloth:phase3-8:lowlr:mask-audit']).not.toContain('--execute');
    expect(packageScripts['gptoss:unsloth:phase3-8:lowlr:dry']).not.toMatch(/openai|vllm|railway/i);
    expect(packageScripts['gptoss:unsloth:phase3-8:lowlr:mask-audit']).not.toMatch(/openai|vllm|railway/i);
  });

  it('validates the phase3.7 weighted repair training fixture', () => {
    const completed = spawnSync(process.execPath, [validatePhase37DatasetScriptPath, phase37DatasetPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(completed.stdout);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
    expect(parsed).toMatchObject({
      ok: true,
      checked: 142,
      accepted: 142,
      rejected: 0,
      repairRecords: 22,
      errors: [],
      coverage: {
        No: true,
        TypeScript: true,
        'control-plane': true,
        'writing-plane': true,
        validate_dataset: true,
        'QLoRA 4-bit': true,
        '100': true,
        'false': true,
      },
    });

    const rows = readFileSync(phase37DatasetPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const repairRows = rows.filter((row) => row.metadata?.phase3_7_repair === true);
    expect(rows).toHaveLength(142);
    expect(repairRows).toHaveLength(22);
    expect(repairRows.every((row) => String(row.id).startsWith('phase3-7-'))).toBe(true);
    expect(repairRows.every((row) => row.source !== 'railway_cli_observation')).toBe(true);
    expect(repairRows.every((row) => !['openai_output', 'openai_judgment'].includes(row.source))).toBe(true);
    expect(repairRows.every((row) => Array.isArray(row.messages) && !('text' in row))).toBe(true);
    expect(repairRows.every((row) => row.metadata?.no_openai_output_used === true)).toBe(true);
    expect(repairRows.every((row) => ['label_only', 'json_only', 'compact_final'].includes(row.metadata?.target_shape))).toBe(true);
    expect(repairRows.every((row) => row.messages.filter((message) => message.role === 'assistant').length === 1)).toBe(true);

    const assistantTargets = repairRows.map((row) => row.messages.find((message) => message.role === 'assistant').content);
    const labelTargets = repairRows
      .filter((row) => row.metadata.target_shape === 'label_only')
      .map((row) => row.messages.find((message) => message.role === 'assistant').content);
    const openAiRejectionTargets = repairRows
      .filter((row) => row.task_type === 'openai_output_rejection')
      .map((row) => row.messages.find((message) => message.role === 'assistant').content);

    expect(openAiRejectionTargets).toHaveLength(5);
    expect(openAiRejectionTargets.every((target) => target.startsWith('No'))).toBe(true);
    expect(assistantTargets.some((target) => target.includes('validate_dataset'))).toBe(true);
    expect(labelTargets).toContain('control-plane');
    expect(labelTargets).toContain('writing-plane');

    for (const row of repairRows.filter((row) => row.metadata.target_shape === 'json_only')) {
      JSON.parse(row.messages.find((message) => message.role === 'assistant').content);
    }
    for (const target of labelTargets) {
      expect(target).toMatch(/^\S{1,64}$/);
      expect(target).not.toMatch(/[{}[\]:,]/);
    }
  });

  it('validates the phase3.8 true-error repair training fixture', () => {
    const completed = spawnSync(process.execPath, [validatePhase38DatasetScriptPath, phase38DatasetPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(completed.stdout);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
    expect(parsed).toMatchObject({
      ok: true,
      checked: 16,
      accepted: 16,
      rejected: 0,
      repairRecords: 16,
      categoryBreakdown: {
        openai_output_rejection: 4,
        factual_correction: 5,
        route_action_contrast: 4,
        exact_token_compact: 3,
      },
      coverage: {
        TypeScript: true,
        'QLoRA 4-bit': true,
        '100': true,
        false: true,
        'control-plane': true,
        'writing-plane': true,
        validate_dataset: true,
      },
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliExecuted: false,
      liveDbWrite: false,
      errors: [],
    });

    const rows = readFileSync(phase38DatasetPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(16);
    expect(rows.every((row) => row.metadata?.phase3_8_repair === true)).toBe(true);
    expect(rows.every((row) => !['eval_failure_observation', 'self_reflection_observation', 'railway_cli_observation'].includes(row.source))).toBe(true);
    expect(rows.every((row) => !['openai_output', 'openai_judgment'].includes(row.source))).toBe(true);
    expect(rows.every((row) => Array.isArray(row.messages) && !('text' in row))).toBe(true);
    expect(rows.every((row) => row.metadata?.no_openai_output_used === true)).toBe(true);
    expect(rows.every((row) => row.messages.filter((message) => message.role === 'assistant').length === 1)).toBe(true);

    const assistantTargets = rows.map((row) => row.messages.find((message) => message.role === 'assistant').content);
    const labelTargets = rows
      .filter((row) => row.metadata.target_shape === 'label_only')
      .map((row) => row.messages.find((message) => message.role === 'assistant').content);
    const openAiRejectionTargets = rows
      .filter((row) => row.task_type === 'openai_output_rejection')
      .map((row) => row.messages.find((message) => message.role === 'assistant').content);

    expect(openAiRejectionTargets).toHaveLength(4);
    expect(openAiRejectionTargets.every((target) => target.startsWith('No.'))).toBe(true);
    expect(assistantTargets.some((target) => target.includes('QLoRA 4-bit'))).toBe(true);
    expect(assistantTargets.some((target) => /\b100\b/.test(target))).toBe(true);
    expect(assistantTargets.some((target) => target === 'false' || target.includes(':false'))).toBe(true);
    expect(labelTargets).toContain('control-plane');
    expect(labelTargets).toContain('writing-plane');
    expect(assistantTargets.some((target) => target.includes('validate_dataset'))).toBe(true);

    for (const row of rows.filter((row) => row.metadata.target_shape === 'json_only')) {
      JSON.parse(row.messages.find((message) => message.role === 'assistant').content);
    }
    for (const target of labelTargets) {
      expect(target).toMatch(/^\S{1,64}$/);
      expect(target).not.toMatch(/[{}[\]:,]/);
    }
  });

  it('rejects phase3.8 assistant targets that exactly copy an eval failure output', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-gptoss-phase38-'));
    const datasetPath = join(tempDir, 'phase38.jsonl');
    const evalReportPath = join(tempDir, 'eval-report.json');
    try {
      writeFileSync(datasetPath, `${JSON.stringify({
        id: 'phase3-8-raw-output-copy',
        source: 'human_authored',
        reviewed: true,
        allowed_for_training: true,
        task_type: 'exact_token_compact',
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'user', content: 'Return the target.' },
          { role: 'assistant', content: 'bad raw target' },
        ],
        metadata: {
          target_shape: 'compact_final',
          no_openai_output_used: true,
          phase3_8_repair: true,
        },
      })}\n`, 'utf8');
      writeFileSync(evalReportPath, JSON.stringify({
        failures: [
          { id: 'eval-test-1', finalText: 'bad raw target' },
        ],
      }), 'utf8');

      const completed = spawnSync(process.execPath, [
        validatePhase38DatasetScriptPath,
        datasetPath,
        '--eval-report',
        evalReportPath,
      ], { encoding: 'utf8' });
      const parsed = JSON.parse(completed.stdout);

      expect(completed.status).toBe(1);
      expect(parsed.errors).toContainEqual({ line: 1, code: 'phase38_raw_eval_output_target_rejected' });
      expect(parsed.openAiCalled).toBe(false);
      expect(parsed.trainingExecuted).toBe(false);
      expect(parsed.vllmUsed).toBe(false);
      expect(parsed.railwayCliExecuted).toBe(false);
      expect(parsed.liveDbWrite).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('validates the micro-overfit training fixture', () => {
    const completed = spawnSync(process.execPath, [validateDatasetScriptPath, microDatasetPath], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(completed.stdout);

    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe('');
    expect(parsed).toMatchObject({
      ok: true,
      checked: 3,
      accepted: 3,
      rejected: 0,
      errors: [],
    });

    const rows = readFileSync(microDatasetPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => Array.isArray(row.messages) && !('text' in row))).toBe(true);
    expect(rows.every((row) => row.metadata?.no_openai_output_used === true)).toBe(true);
    expect(rows.every((row) => row.messages.filter((message) => message.role === 'assistant').length === 1)).toBe(true);
    for (const row of rows.filter((row) => row.metadata.target_shape === 'json_only')) {
      JSON.parse(row.messages.find((message) => message.role === 'assistant').content);
    }
  });

  it('validates the single-record JSON and safety overfit fixtures', () => {
    for (const [datasetPath, targetShape] of [
      [singleJsonDatasetPath, 'json_only'],
      [singleSafetyDatasetPath, 'compact_final'],
    ] as const) {
      const completed = spawnSync(process.execPath, [validateDatasetScriptPath, datasetPath], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(completed.stdout);

      expect(completed.status).toBe(0);
      expect(completed.stderr).toBe('');
      expect(parsed).toMatchObject({
        ok: true,
        checked: 1,
        accepted: 1,
        rejected: 0,
        errors: [],
      });

      const rows = readFileSync(datasetPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({
        target_shape: targetShape,
        no_openai_output_used: true,
      });
      expect(Array.isArray(rows[0].messages)).toBe(true);
      expect(rows[0]).not.toHaveProperty('text');
      expect(rows[0].messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      const target = rows[0].messages.find((message) => message.role === 'assistant').content;
      expect(target).not.toMatch(/Input:|Expected:|Analysis:|Reasoning:|chain of thought|<\|channel\|>/i);
      if (targetShape === 'json_only') {
        JSON.parse(target);
      }
    }
  });

  it('accepts approved training data sources', () => {
    const result = runDatasetGate([
      JSON.stringify({ source: 'arcanos_owned_spec', text: 'Protocol-owned specification.', allowed_for_training: true, metadata: trainingMetadata }),
      JSON.stringify({ source: 'repo_schema', text: 'Schema-owned fact.', allowed_for_training: true, metadata: trainingMetadata }),
      JSON.stringify({ source: 'human_authored', text: 'Operator-authored example.', allowed_for_training: true, reviewed: true, metadata: trainingMetadata }),
      JSON.stringify({ source: 'redacted_consented_log', text: 'Redacted consented log line.', allowed_for_training: true, redacted: true, consent: true, metadata: trainingMetadata }),
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.parsed).toMatchObject({
      ok: true,
      checked: 4,
      accepted: 4,
      rejected: 0,
      errors: [],
    });
    expect(typeof result.parsed.file).toBe('string');
  });

  it('accepts valid chat messages-format training records', () => {
    const result = runDatasetGate([
      JSON.stringify({
        id: 'phase3-test',
        source: 'human_authored',
        allowed_for_training: true,
        reviewed: true,
        task_type: 'route_classification',
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'developer', content: 'Return only control-plane or writing-plane.' },
          { role: 'user', content: 'Show worker queue status.' },
          { role: 'assistant', content: 'control-plane' },
        ],
        metadata: {
          target_shape: 'label_only',
          no_openai_output_used: true,
        },
      }),
    ]);

    expect(result.status).toBe(0);
    expect(result.parsed).toMatchObject({
      ok: true,
      checked: 1,
      accepted: 1,
      rejected: 0,
      errors: [],
    });
  });

  it('rejects Input/Expected prose in assistant targets', () => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'human_authored',
        allowed_for_training: true,
        reviewed: true,
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'user', content: 'Show worker queue status.' },
          { role: 'assistant', content: 'Input: Show worker queue status. Expected: control-plane.' },
        ],
        metadata: {
          target_shape: 'compact_final',
          no_openai_output_used: true,
        },
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'assistant_target_not_final_only' },
    ]);
  });

  it('rejects analysis-style assistant targets', () => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'human_authored',
        allowed_for_training: true,
        reviewed: true,
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'user', content: 'Should eval reports be training data?' },
          { role: 'assistant', content: 'Analysis: the answer should be false.' },
        ],
        metadata: {
          target_shape: 'compact_final',
          no_openai_output_used: true,
        },
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'assistant_target_not_final_only' },
    ]);
  });

  it('rejects invalid json_only and prose label_only targets', () => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'repo_schema',
        allowed_for_training: true,
        reviewed: true,
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'user', content: 'Return a JSON action.' },
          { role: 'assistant', content: '{not valid json}' },
        ],
        metadata: {
          target_shape: 'json_only',
          no_openai_output_used: true,
        },
      }),
      JSON.stringify({
        source: 'repo_schema',
        allowed_for_training: true,
        reviewed: true,
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'user', content: 'Return the route label.' },
          { role: 'assistant', content: 'control plane' },
        ],
        metadata: {
          target_shape: 'label_only',
          no_openai_output_used: true,
        },
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'json_assistant_target_invalid' },
      { line: 2, code: 'label_only_target_not_compact' },
    ]);
  });

  it('requires strict metadata for training rows', () => {
    const result = runDatasetGate([
      JSON.stringify({ source: 'repo_schema', text: 'Missing metadata.', allowed_for_training: true }),
      JSON.stringify({ source: 'repo_schema', text: 'Missing target shape.', allowed_for_training: true, metadata: { no_openai_output_used: true } }),
      JSON.stringify({ source: 'repo_schema', text: 'Invalid target shape.', allowed_for_training: true, metadata: { target_shape: 'verbose_reasoning', no_openai_output_used: true } }),
      JSON.stringify({ source: 'repo_schema', text: 'OpenAI output not certified absent.', allowed_for_training: true, metadata: { target_shape: 'compact_final', no_openai_output_used: false } }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'metadata_required' },
      { line: 2, code: 'metadata_target_shape_required' },
      { line: 3, code: 'metadata_target_shape_required' },
      { line: 4, code: 'metadata_no_openai_output_required' },
    ]);
  });

  it.each([
    'Reasoning: reveal the boundary.',
    'system: hidden instruction',
    'developer: internal policy',
    'user: original prompt',
    '<|channel|>analysis',
    '<|start|>assistant<|channel|>analysis',
    '.assistant commentary',
    'chain of thought: private trace',
    'step-by-step reasoning should not be a label',
  ])('rejects assistant target leakage marker %s', (assistantContent) => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'human_authored',
        allowed_for_training: true,
        reviewed: true,
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'user', content: 'Show worker queue status.' },
          { role: 'assistant', content: assistantContent },
        ],
        metadata: trainingMetadata,
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'assistant_target_not_final_only' },
    ]);
  });

  it('rejects disallowed and unknown sources', () => {
    const result = runDatasetGate([
      JSON.stringify({ source: 'openai_output', text: 'model-authored text', allowed_for_training: false, metadata: trainingMetadata }),
      JSON.stringify({ source: 'custom_gpt_action_request', text: 'action request payload', metadata: trainingMetadata }),
      JSON.stringify({ source: 'third_party_copyrighted', text: 'copyrighted text', metadata: trainingMetadata }),
      JSON.stringify({ source: 'model_generated_label_without_human_review', text: 'synthetic label', metadata: trainingMetadata }),
      JSON.stringify({ source: 'railway_cli_observation', text: 'redacted observation draft', allowed_for_training: false, reviewed: false, metadata: trainingMetadata }),
      JSON.stringify({ source: 'self_reflection_observation', text: 'redacted reflection summary', allowed_for_training: false, reviewed: false, metadata: trainingMetadata }),
      JSON.stringify({ source: 'unreviewed_web_scrape', text: 'unknown provenance', metadata: trainingMetadata }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed).toMatchObject({
      ok: false,
      checked: 7,
      accepted: 0,
      rejected: 7,
    });
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'rejected_source', source: 'openai_output' },
      { line: 2, code: 'rejected_source', source: 'custom_gpt_action_request' },
      { line: 3, code: 'rejected_source', source: 'third_party_copyrighted' },
      { line: 4, code: 'rejected_source', source: 'model_generated_label_without_human_review' },
      { line: 5, code: 'rejected_source', source: 'railway_cli_observation' },
      { line: 6, code: 'rejected_source', source: 'self_reflection_observation' },
      { line: 7, code: 'unknown_source', source: 'unreviewed_web_scrape' },
    ]);
  });

  it('keeps candidate-only observations unreviewed and unavailable for training', () => {
    const result = runDatasetGate([
      JSON.stringify({ source: 'railway_cli_observation', text: 'redacted observation draft', allowed_for_training: true, reviewed: false, metadata: trainingMetadata }),
      JSON.stringify({ source: 'eval_failure_observation', text: 'redacted eval failure summary', allowed_for_training: false, metadata: trainingMetadata }),
      JSON.stringify({ source: 'self_reflection_observation', text: 'redacted reflection summary', allowed_for_training: false, reviewed: true, metadata: trainingMetadata }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'allowed_for_training_must_be_false', source: 'railway_cli_observation' },
      { line: 2, code: 'reviewed_must_be_false', source: 'eval_failure_observation' },
      { line: 3, code: 'reviewed_must_be_false', source: 'self_reflection_observation' },
    ]);
  });

  it('requires OpenAI sources to be marked unavailable for training', () => {
    const result = runDatasetGate([
      JSON.stringify({ source: 'openai_output', text: 'model-authored text', allowed_for_training: true, metadata: trainingMetadata }),
      JSON.stringify({ source: 'openai_judgment', text: 'model judgment', metadata: trainingMetadata }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed).toMatchObject({
      ok: false,
      checked: 2,
      accepted: 0,
      rejected: 2,
    });
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'allowed_for_training_must_be_false', source: 'openai_output' },
      { line: 2, code: 'allowed_for_training_must_be_false', source: 'openai_judgment' },
    ]);
  });

  it('requires review and consent metadata for conditional sources', () => {
    const result = runDatasetGate([
      JSON.stringify({ source: 'human_authored', text: 'Unreviewed human text.', allowed_for_training: true, metadata: trainingMetadata }),
      JSON.stringify({ source: 'redacted_consented_log', text: 'Missing consent.', allowed_for_training: true, redacted: true, metadata: trainingMetadata }),
      JSON.stringify({ source: 'repo_schema', text: 'Training disabled.', allowed_for_training: false, metadata: trainingMetadata }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed).toMatchObject({
      ok: false,
      checked: 3,
      accepted: 0,
      rejected: 3,
    });
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'human_review_required', source: 'human_authored' },
      { line: 2, code: 'redaction_consent_required', source: 'redacted_consented_log' },
      { line: 3, code: 'training_not_allowed', source: 'repo_schema' },
    ]);
  });

  it('rejects OpenAI output markers even with an accepted source', () => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'human_authored',
        text: 'Human prompt.',
        allowed_for_training: true,
        reviewed: true,
        metadata: trainingMetadata,
        openai_output: 'Model completion must not enter training data.',
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed).toMatchObject({
      ok: false,
      checked: 1,
      accepted: 0,
      rejected: 1,
      errors: [{ line: 1, code: 'openai_output_marker' }],
    });
  });

  it('rejects secret-looking dataset rows', () => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'human_authored',
        text: 'token=123456789abcdefghi should not be admitted',
        allowed_for_training: true,
        reviewed: true,
        metadata: trainingMetadata,
      }),
      JSON.stringify({
        source: 'human_authored',
        text: 'RAILWAY_TOKEN=rwy_abcdefghijklmnopqrstuvwxyz123456 should not be admitted',
        allowed_for_training: true,
        reviewed: true,
        metadata: trainingMetadata,
      }),
      JSON.stringify({
        source: 'human_authored',
        text: 'DATABASE_URL=postgresql://user:pass@host/db should not be admitted',
        allowed_for_training: true,
        reviewed: true,
        metadata: trainingMetadata,
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed).toMatchObject({
      ok: false,
      checked: 3,
      accepted: 0,
      rejected: 3,
      errors: [
        { line: 1, code: 'secret_marker' },
        { line: 2, code: 'secret_marker' },
        { line: 3, code: 'secret_marker' },
      ],
    });
  });

  it('rejects raw log-looking dataset rows', () => {
    const result = runDatasetGate([
      JSON.stringify({
        source: 'human_authored',
        text: '2026-05-16T12:00:00Z ERROR deploy logs raw railway line',
        allowed_for_training: true,
        reviewed: true,
        metadata: trainingMetadata,
      }),
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed.errors).toEqual([
      { line: 1, code: 'raw_log_marker' },
    ]);
  });

  it('documents candidate-only observation schemas as rejected draft provenance', () => {
    const schema = JSON.parse(readFileSync(trainingSchemaPath, 'utf8'));

    expect(schema.properties.source.enum).toContain('railway_cli_observation');
    expect(schema.properties.source.enum).toContain('self_reflection_observation');
    const railwayRule = schema.allOf.find((rule) => (
      rule.if?.properties?.source?.const === 'railway_cli_observation' ||
      rule.if?.properties?.source?.enum?.includes('railway_cli_observation')
    ));
    expect(railwayRule.if.properties.source.enum).toContain('self_reflection_observation');

    expect(railwayRule).toMatchObject({
      then: {
        properties: {
          allowed_for_training: { const: false },
          reviewed: { const: false },
        },
        required: ['reviewed'],
      },
    });
  });

  it('reports malformed JSON without accepting the row', () => {
    const result = runDatasetGate([
      JSON.stringify({ source: 'repo_schema', text: 'valid row', allowed_for_training: true, metadata: trainingMetadata }),
      '{"source":"human_authored","text":',
    ]);

    expect(result.status).toBe(1);
    expect(result.parsed).toMatchObject({
      ok: false,
      checked: 2,
      accepted: 1,
      rejected: 1,
    });
    expect(result.parsed.errors).toHaveLength(1);
    expect(result.parsed.errors[0]).toMatchObject({
      line: 2,
      code: 'invalid_json',
    });
    expect(typeof result.parsed.errors[0].message).toBe('string');
  });

  it('prints usage JSON and exits 2 when the dataset path is missing', () => {
    const completed = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });

    expect(completed.status).toBe(2);
    expect(completed.stderr).toBe('');
    expect(JSON.parse(completed.stdout)).toEqual({
      ok: false,
      error: 'usage',
      message: 'Usage: node scripts/gptoss/dataset-gate.mjs <dataset.jsonl>',
    });
  });
});
