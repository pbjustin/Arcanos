import { clearOpenAiClientCache, getOpenAiClient, resolveOpenAiConfig } from '../src/lib/openaiClient';

describe('openaiClient', () => {
  afterEach(() => {
    clearOpenAiClientCache();
  });

  it('returns error when OPENAI_API_KEY is missing', () => {
    const result = resolveOpenAiConfig(() => undefined);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('caches OpenAI client instances for the same config', () => {
    const envGetter = (key: string) => (key === 'OPENAI_API_KEY' ? 'test-key' : undefined);
    const first = getOpenAiClient(envGetter);
    const second = getOpenAiClient(envGetter);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.client).toBeDefined();
    expect(first.client).toBe(second.client);
  });

  const shouldRunConnectivity = Boolean(process.env.OPENAI_API_KEY);
  (shouldRunConnectivity ? it : it.skip)('connects to OpenAI when API key is provided', async () => {
    const result = getOpenAiClient();
    expect(result.ok).toBe(true);
    if (!result.ok || !result.client) {
      return;
    }
    const models = await result.client.models.list();
    expect(models.data.length).toBeGreaterThan(0);
  });
});
