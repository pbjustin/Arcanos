import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = join(process.cwd(), 'scripts', 'gptoss', 'eval-force-final-comparison.mjs');
const outputDir = join('local_artifacts', 'gptoss-force-final-comparison-test');
const fixtureAdapterDir = join('local_artifacts', 'gptoss-force-final-fixture-adapter');

function runScript(args: string[]) {
  return spawnSync('node', [scriptPath, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function writeFixtureAdapter() {
  mkdirSync(fixtureAdapterDir, { recursive: true });
  writeFileSync(join(fixtureAdapterDir, 'adapter_config.json'), '{}\n', 'utf8');
  writeFileSync(join(fixtureAdapterDir, 'adapter_model.safetensors'), 'adapter\n', 'utf8');
  writeFileSync(join(fixtureAdapterDir, 'adapter-metadata.json'), '{"noOpenAiOutputUsed":true}\n', 'utf8');
  writeFileSync(join(fixtureAdapterDir, 'eval-force-final.json'), JSON.stringify({
    ok: false,
    records: 24,
    passed: 1,
    failed: 23,
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    noOpenAiOutputUsed: true,
    failures: [
      {
        id: 'eval-smoke-json',
        reason: 'invalid_json',
        validJson: false,
        finalText: 'not json',
      },
    ],
  }), 'utf8');
}

describe('gptoss force-final comparison wrapper', () => {
  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
    rmSync(fixtureAdapterDir, { recursive: true, force: true });
  });

  it('writes an inventory report with safety fields and skips missing adapters', () => {
    const result = runScript([
      '--inventory-only',
      '--adapter-dir',
      join('local_artifacts', 'missing-force-final-adapter'),
      '--output-dir',
      outputDir,
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      noOpenAiOutputUsed: true,
    });
    expect(parsed.adapters[0]).toMatchObject({
      validForEval: false,
      skipped: true,
      skipReason: 'adapter_directory_missing',
    });
  });

  it('builds a summary from existing reports without running heavy evals', () => {
    writeFixtureAdapter();
    const result = runScript([
      '--summary-only',
      '--adapter-dir',
      fixtureAdapterDir,
      '--output-dir',
      outputDir,
    ]);
    const parsed = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(parsed.summary).toMatchObject({
      ok: true,
      forceFinalChannel: true,
      bestAdapter: 'force-final-fixture-adapter',
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      noOpenAiOutputUsed: true,
    });
    expect(parsed.summary.adapters[0].forceFinalEval).toMatchObject({
      reportExists: true,
      passed: 1,
      failed: 23,
    });
    expect(parsed.breakdown.categories[0]).toMatchObject({
      category: 'invalid JSON',
      count: 1,
    });
  });

  it('treats nonzero eval exits with reports as eval failures in the wrapper source', () => {
    const source = spawnSync('powershell', ['-NoProfile', '-Command', `Get-Content ${scriptPath}`], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).stdout;
    expect(source).toContain("reportExists ? 'report_written_eval_failed' : 'infrastructure_failed'");
    expect(source).toContain('openAiCalled: false');
    expect(source).toContain('trainingExecuted: false');
    expect(source).toContain('vllmUsed: false');
  });
});
