import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

type GptModuleMap = Record<string, { route: string; module: string }>;

const getGptModuleMapMock = jest.fn<() => Promise<GptModuleMap>>();

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  getGptModuleMap: getGptModuleMapMock,
}));

const { isRegisteredResearchGptId } = await import(
  '../src/services/researchGptRouting.js'
);
const originalGptModuleMap = process.env.GPT_MODULE_MAP;

describe('Research GPT routing admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GPT_MODULE_MAP;
  });

  afterEach(() => {
    if (originalGptModuleMap === undefined) {
      delete process.env.GPT_MODULE_MAP;
    } else {
      process.env.GPT_MODULE_MAP = originalGptModuleMap;
    }
  });

  it('rejects an unrelated GPT ID without loading the full module map', async () => {
    getGptModuleMapMock.mockRejectedValue(
      new Error('the module map must remain unloaded'),
    );

    await expect(isRegisteredResearchGptId('arcanos-core')).resolves.toBe(false);
    expect(getGptModuleMapMock).not.toHaveBeenCalled();
  });

  it('requires the authoritative map to confirm a built-in Research ID', async () => {
    getGptModuleMapMock.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });

    await expect(isRegisteredResearchGptId('research')).resolves.toBe(true);
    expect(getGptModuleMapMock).toHaveBeenCalledTimes(1);
  });

  it('recognizes an opaque configured candidate only when the map confirms it', async () => {
    process.env.GPT_MODULE_MAP = JSON.stringify({
      'library-custom': { route: 'research', module: 'ARCANOS:RESEARCH' },
    });
    getGptModuleMapMock.mockResolvedValue({
      'library-custom': { route: 'research', module: 'ARCANOS:CORE' },
    });

    await expect(isRegisteredResearchGptId('library-custom')).resolves.toBe(false);
    expect(getGptModuleMapMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an exact non-Research alias before fuzzy Research matching loads the map', async () => {
    process.env.GPT_MODULE_MAP = JSON.stringify({
      'research-helper': { route: 'core', module: 'ARCANOS:CORE' },
    });
    getGptModuleMapMock.mockRejectedValue(
      new Error('the module map must remain unloaded'),
    );

    await expect(isRegisteredResearchGptId('research-helper')).resolves.toBe(false);
    expect(getGptModuleMapMock).not.toHaveBeenCalled();
  });

  it('defers an invalid exact override to the authoritative map', async () => {
    process.env.GPT_MODULE_MAP = JSON.stringify({
      'research-helper': { route: 'not-core', module: 'ARCANOS:CORE' },
    });
    getGptModuleMapMock.mockResolvedValue({
      research: { route: 'research', module: 'ARCANOS:RESEARCH' },
    });

    await expect(isRegisteredResearchGptId('research-helper')).resolves.toBe(true);
    expect(getGptModuleMapMock).toHaveBeenCalledTimes(1);
  });
});
