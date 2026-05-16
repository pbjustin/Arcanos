import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = join(process.cwd(), 'scripts', 'gptoss', 'audit-target-likelihood.py');
const wrapperPath = join(process.cwd(), 'scripts', 'gptoss', 'audit-target-likelihood.mjs');
const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function runPython(args: string[]) {
  return spawnSync('python', [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function makeFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-gptoss-likelihood-'));
  const adapterDir = join(tempDir, 'adapter');
  const artifactDir = join(process.cwd(), 'local_artifacts', 'gptoss-likelihood-test');
  const outputPath = join(artifactDir, 'target-likelihood-audit.json');
  const decisionPath = join(artifactDir, 'target-likelihood-decision.json');
  const trainingFile = join(tempDir, 'training.jsonl');
  mkdirSync(adapterDir, { recursive: true });
  writeFileSync(join(adapterDir, 'adapter_config.json'), JSON.stringify({
    target_modules: ['q_proj'],
    target_parameters: ['mlp.experts.gate_up_proj'],
  }), 'utf8');
  writeFileSync(join(adapterDir, 'adapter-metadata.json'), JSON.stringify({
    noOpenAiOutputUsed: true,
  }), 'utf8');
  writeFileSync(join(adapterDir, 'adapter_model.safetensors'), 'adapter-bytes', 'utf8');
  writeFileSync(trainingFile, `${JSON.stringify({
    id: 'likelihood-test-001',
    source: 'repo_schema',
    reviewed: true,
    allowed_for_training: true,
    task_type: 'json_action_schema',
    messages: [
      { role: 'system', content: 'Return only the final answer.' },
      { role: 'developer', content: 'Return only a JSON object.' },
      { role: 'user', content: 'Return JSON for a local dataset validation action with no secrets.' },
      { role: 'assistant', content: '{"action":"validate_dataset","allowedForTraining":false}' },
    ],
    metadata: { target_shape: 'json_only', no_openai_output_used: true },
  })}\n`, 'utf8');
  return { tempDir, adapterDir, outputPath, decisionPath, trainingFile };
}

describe('gptoss target likelihood audit', () => {
  it('defines the single JSON likelihood audit package script', () => {
    const script = packageJson.scripts['gptoss:single-json:likelihood-audit'];
    expect(script).toContain('node scripts/gptoss/audit-target-likelihood.mjs');
    expect(script).toContain('--execute');
    expect(script).toContain('--adapter-dir local_artifacts/gptoss-single-json-overfit');
    expect(script).toContain('--training-file examples/gptoss/arcanos-single-json-overfit-training.jsonl');
    expect(script).toContain('--output local_artifacts/gptoss-single-json-overfit/target-likelihood-audit.json');
    expect(script).toContain('--decision-output local_artifacts/gptoss-single-json-overfit/target-likelihood-decision.json');
  });

  it('keeps the audit source local, non-generative, and non-training', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const wrapper = readFileSync(wrapperPath, 'utf8');
    expect(source).not.toContain('api.openai.com');
    expect(source).not.toContain('model.generate(');
    expect(source).not.toContain('trainer.train(');
    expect(source).toContain('"openAiCalled": False');
    expect(source).toContain('"trainingExecuted": False');
    expect(source).toContain('"vllmUsed": False');
    expect(wrapper).toContain('/root/unsloth-gptoss-env/bin/activate');
  });

  it('validates report shape and safety fields in dry-run mode', () => {
    const fixture = makeFixture();
    try {
      const result = runPython([
        '--dry-run',
        '--adapter-dir', fixture.adapterDir,
        '--training-file', fixture.trainingFile,
        '--output', fixture.outputPath,
        '--decision-output', fixture.decisionPath,
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(0);
      expect(parsed).toMatchObject({
        ok: true,
        mode: 'dry-run',
        executed: false,
        recordId: 'likelihood-test-001',
        adapterDir: fixture.adapterDir,
        targetText: '{"action":"validate_dataset","allowedForTraining":false}',
        allowedForTraining: false,
        openAiCalled: false,
        trainingExecuted: false,
        vllmUsed: false,
        noOpenAiOutputUsed: true,
      });
      expect(parsed.targetTokenCount).toBeGreaterThan(0);
      expect(parsed.supervisedTokenCount).toBeGreaterThan(parsed.targetTokenCount);
      expect(parsed.boundaryTokenPreview).toContain('final');
      expect(parsed.adapterActivation).toMatchObject({
        adapterConfigExists: true,
        adapterModelExists: true,
        adapterLoaded: false,
        baseForwardCompleted: false,
        adapterForwardCompleted: false,
      });
      const decision = JSON.parse(readFileSync(fixture.decisionPath, 'utf8'));
      expect(decision).toMatchObject({
        decision: 'scorer_or_extraction_suspect',
        allowedForTraining: false,
        openAiCalled: false,
        trainingExecuted: false,
        vllmUsed: false,
        noOpenAiOutputUsed: true,
      });
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
      rmSync(join(process.cwd(), 'local_artifacts', 'gptoss-likelihood-test'), { recursive: true, force: true });
    }
  });

  it('fails clearly when the adapter directory is missing', () => {
    const fixture = makeFixture();
    try {
      const result = runPython([
        '--dry-run',
        '--adapter-dir', join(fixture.tempDir, 'missing-adapter'),
        '--training-file', fixture.trainingFile,
        '--output', fixture.outputPath,
        '--decision-output', fixture.decisionPath,
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(2);
      expect(parsed).toMatchObject({
        ok: false,
        error: 'adapter_loading_suspect',
        allowedForTraining: false,
        openAiCalled: false,
        trainingExecuted: false,
        vllmUsed: false,
        noOpenAiOutputUsed: true,
      });
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
      rmSync(join(process.cwd(), 'local_artifacts', 'gptoss-likelihood-test'), { recursive: true, force: true });
    }
  });

  it('fails clearly when the target span is missing', () => {
    const fixture = makeFixture();
    try {
      const badTrainingFile = join(fixture.tempDir, 'bad-training.jsonl');
      writeFileSync(badTrainingFile, `${JSON.stringify({
        id: 'likelihood-bad-span-001',
        source: 'repo_schema',
        reviewed: true,
        allowed_for_training: true,
        task_type: 'json_action_schema',
        messages: [
          { role: 'system', content: 'Return only the final answer.' },
          { role: 'developer', content: 'Return only a JSON object.' },
          { role: 'user', content: 'Return JSON for a local dataset validation action with no secrets.' },
          { role: 'assistant', content: '' },
        ],
        metadata: { target_shape: 'json_only', no_openai_output_used: true },
      })}\n`, 'utf8');
      const result = runPython([
        '--dry-run',
        '--adapter-dir', fixture.adapterDir,
        '--training-file', badTrainingFile,
        '--output', fixture.outputPath,
        '--decision-output', fixture.decisionPath,
      ]);
      const parsed = JSON.parse(result.stdout);
      expect(result.status).toBe(2);
      expect(parsed).toMatchObject({
        ok: false,
        error: 'target_span_suspect',
        allowedForTraining: false,
        openAiCalled: false,
        trainingExecuted: false,
        vllmUsed: false,
        noOpenAiOutputUsed: true,
      });
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
      rmSync(join(process.cwd(), 'local_artifacts', 'gptoss-likelihood-test'), { recursive: true, force: true });
    }
  });
});
