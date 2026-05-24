import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadTriageModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'triage-adapter-eval.mjs')).href);
}

describe('gptoss adapter failure triage', () => {
  it('classifies failures and keeps training disabled', async () => {
    const triageModule = await loadTriageModule() as {
      buildTriage: (report: unknown) => {
        totalFailures: number;
        safeToTrainAgain: boolean;
        categories: Record<string, { count: number; ids: string[] }>;
        topRootCauseHypotheses: string[];
      };
    };
    const triage = triageModule.buildTriage({
      reportPath: 'local_artifacts/gptoss-phase2/eval-report.json',
      records: 2,
      passed: 0,
      failed: 2,
      maxNewTokens: 64,
      noOpenAiOutputUsed: true,
      chatTemplateUsed: true,
      chatTemplateFallbackUsed: false,
      decoding: {
        maxNewTokens: 96,
        doSample: true,
        temperature: 0.1,
        topP: 0.9,
        repetitionPenalty: 1.15,
        eosTokenIdPresent: true,
        padTokenIdPresent: true,
      },
      failures: [
        {
          id: 'eval-smoke-001',
          reason: 'plane_mismatch, missing:control',
          observedSummary: 'Show Show Show Show Show Show Show Show',
        },
        {
          id: 'eval-smoke-006',
          reason: 'invalid_json, missing:validate_dataset',
          observedSummary: 'No secrets. No secrets. No secrets. No secrets.',
        },
      ],
    });

    expect(triage.totalFailures).toBe(2);
    expect(triage.safeToTrainAgain).toBe(false);
    expect(triage.categories.repetition_or_degenerate_output.count).toBe(2);
    expect(triage.categories.invalid_json.ids).toEqual(['eval-smoke-006']);
    expect(triage.categories.route_classification_wrong.ids).toEqual(['eval-smoke-001']);
    expect(triage.promptTemplateAssessment.appearsValid).toBe(true);
    expect(triage.generationSettingsAssessment.current).toMatchObject({
      maxNewTokens: 96,
      doSample: true,
      temperature: 0.1,
      topP: 0.9,
      repetitionPenalty: 1.15,
    });
  });

  it('writes triage reports only under local_artifacts', async () => {
    const triageModule = await loadTriageModule() as {
      run: (options: { report: string; output: string }) => unknown;
    };
    const tempDir = mkdtempSync(join(tmpdir(), 'arcanos-triage-'));
    const reportPath = join(tempDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify({
      reportPath,
      records: 1,
      passed: 0,
      failed: 1,
      noOpenAiOutputUsed: true,
      failures: [{ id: 'eval-smoke-024', reason: 'missing:false', observedSummary: 'eval eval eval eval eval eval' }],
    }), 'utf8');

    try {
      expect(() => triageModule.run({ report: reportPath, output: join(tempDir, 'triage.json') })).toThrow(/local_artifacts/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
