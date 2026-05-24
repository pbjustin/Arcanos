import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jest } from '@jest/globals';

async function loadHealthModule() {
  return import(pathToFileURL(join(process.cwd(), 'scripts', 'gptoss', 'endpoint-health.mjs')).href);
}

describe('gptoss endpoint health', () => {
  const originalGptossApiBaseUrl = process.env.GPTOSS_API_BASE_URL;
  const originalGptossLocalApiBaseUrl = process.env.GPTOSS_LOCAL_API_BASE_URL;
  const originalGptossModel = process.env.GPTOSS_MODEL;
  const originalGptossLocalModel = process.env.GPTOSS_LOCAL_MODEL;

  afterEach(() => {
    if (originalGptossApiBaseUrl === undefined) {
      delete process.env.GPTOSS_API_BASE_URL;
    } else {
      process.env.GPTOSS_API_BASE_URL = originalGptossApiBaseUrl;
    }

    if (originalGptossLocalApiBaseUrl === undefined) {
      delete process.env.GPTOSS_LOCAL_API_BASE_URL;
    } else {
      process.env.GPTOSS_LOCAL_API_BASE_URL = originalGptossLocalApiBaseUrl;
    }

    if (originalGptossModel === undefined) {
      delete process.env.GPTOSS_MODEL;
    } else {
      process.env.GPTOSS_MODEL = originalGptossModel;
    }

    if (originalGptossLocalModel === undefined) {
      delete process.env.GPTOSS_LOCAL_MODEL;
    } else {
      process.env.GPTOSS_LOCAL_MODEL = originalGptossLocalModel;
    }
  });

  it('defaults to the vLLM GPTOSS_API_BASE_URL endpoint family', async () => {
    const health = await loadHealthModule() as {
      parseArgs: (argv: string[]) => { baseUrl: string; model: string };
    };
    delete process.env.GPTOSS_API_BASE_URL;
    delete process.env.GPTOSS_LOCAL_API_BASE_URL;
    delete process.env.GPTOSS_MODEL;
    delete process.env.GPTOSS_LOCAL_MODEL;

    expect(health.parseArgs([])).toMatchObject({
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'openai/gpt-oss-20b',
    });
  });

  it('reports missing local GPT-OSS endpoint without throwing', async () => {
    const health = await loadHealthModule() as {
      probeEndpoint: (config: unknown) => Promise<unknown>;
    };
    const fetchMock = jest.fn().mockRejectedValue(new Error('connect refused'));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      await expect(health.probeEndpoint({
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'openai/gpt-oss-20b',
        timeoutMs: 100,
        allowNonLocal: false,
        dryRun: false,
      })).resolves.toMatchObject({
        ok: false,
        baseUrl: 'http://127.0.0.1:8000/v1',
        modelsUrl: 'http://127.0.0.1:8000/v1/models',
        errorClass: 'endpoint_unavailable',
        message: 'connect refused',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
