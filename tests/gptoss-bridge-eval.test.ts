import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jest } from '@jest/globals';

async function loadEvalModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'bridge-eval.mjs')).href);
}

describe('gptoss bridge eval', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalGptossApiBaseUrl = process.env.GPTOSS_API_BASE_URL;

  afterEach(() => {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }

    if (originalGptossApiBaseUrl === undefined) {
      delete process.env.GPTOSS_API_BASE_URL;
    } else {
      process.env.GPTOSS_API_BASE_URL = originalGptossApiBaseUrl;
    }
  });

  it('supports dry-run without configured endpoints', async () => {
    const bridgeEval = await loadEvalModule() as {
      runBridgeEval: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };
    delete process.env.GPTOSS_API_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    const fetchMock = jest.fn();

    const result = await bridgeEval.runBridgeEval({
      mode: 'dry-run',
      prompt: 'Summarize the bridge policy.',
    }, { fetchImpl: fetchMock }) as { candidate?: { status?: string }; reference?: unknown };

    expect(result).toMatchObject({
      candidate: { status: 'dry_run' },
      reference: { status: 'skipped', errorClass: 'dry_run_no_network' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('OPENAI_RAW_OUTPUT');
  });

  it('does not require OPENAI_API_KEY for local-only eval', async () => {
    const bridgeEval = await loadEvalModule() as {
      runBridgeEval: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };
    delete process.env.OPENAI_API_KEY;
    process.env.GPTOSS_API_BASE_URL = 'http://gptoss.local.test/v1';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'LOCAL_ONLY_OUTPUT_SENTINEL' } }],
      }),
    });

    const result = await bridgeEval.runBridgeEval({
      mode: 'compare',
      prompt: 'Run local only.',
      allowNetwork: true,
      localOnly: true,
    }, { fetchImpl: fetchMock }) as {
      candidate?: { status?: string; output?: string };
      reference?: { status?: string; errorClass?: string };
    };

    expect(result).toMatchObject({
      candidate: { status: 'ok', output: 'LOCAL_ONLY_OUTPUT_SENTINEL' },
      reference: { status: 'skipped', errorClass: 'reference_not_enabled' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports missing local GPT-OSS endpoint clearly', async () => {
    const bridgeEval = await loadEvalModule() as {
      runBridgeEval: (input: unknown, dependencies?: unknown) => Promise<unknown>;
    };
    process.env.GPTOSS_API_BASE_URL = 'http://127.0.0.1:8000/v1';
    const fetchMock = jest.fn().mockRejectedValue(new Error('connect refused'));

    const result = await bridgeEval.runBridgeEval({
      mode: 'compare',
      prompt: 'Run local candidate.',
      allowNetwork: true,
      localOnly: true,
    }, { fetchImpl: fetchMock }) as {
      candidate?: { status?: string; errorClass?: string; errorMessage?: string; endpoint?: string };
      reference?: { status?: string };
      allowedForTraining?: boolean;
    };

    expect(result).toMatchObject({
      candidate: {
        status: 'error',
        errorClass: 'endpoint_unavailable',
        errorMessage: 'connect refused',
        endpoint: 'http://127.0.0.1:8000/v1',
      },
      reference: { status: 'skipped' },
      allowedForTraining: false,
    });
  });

  it('rejects attempts to include OpenAI reference output in reports', async () => {
    const bridgeEval = await loadEvalModule() as {
      parseArgs: (argv: string[]) => unknown;
    };

    expect(() => bridgeEval.parseArgs(['--show-reference-output'])).toThrow(
      'OpenAI reference output must not be included'
    );
  });
});
