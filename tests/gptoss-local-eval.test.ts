import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadEvalModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'eval-local-candidate.mjs')).href);
}

describe('gptoss local eval runner', () => {
  it('runs the safe eval baseline in dry-run mode', async () => {
    const localEval = await loadEvalModule() as {
      runEval: (options: unknown) => Promise<unknown>;
      parseArgs: (argv?: string[]) => unknown;
    };

    const report = await localEval.runEval(localEval.parseArgs(['--dry-run'])) as {
      total?: number;
      failed?: number;
      allowedForTraining?: boolean;
      openAiCalled?: boolean;
    };

    expect(report.total).toBeGreaterThanOrEqual(20);
    expect(report.failed).toBe(0);
    expect(report.allowedForTraining).toBe(false);
    expect(report.openAiCalled).toBe(false);
  });

  it('rejects unsafe eval records', async () => {
    const localEval = await loadEvalModule() as {
      validateEvalRecord: (record: unknown, index: number) => string[];
    };

    const errors = localEval.validateEvalRecord({
      id: 'bad',
      source: 'openai_output',
      allowed_for_eval: true,
      prompt: 'Use this output.',
      expected: { must_include: ['ok'] },
    }, 0);

    expect(errors.join(' ')).toContain('unsafe_source');
  });
});
