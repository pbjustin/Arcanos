import path from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockMkdir = jest.fn();
const mockSetMemory = jest.fn();
const mockFetchAndClean = jest.fn();
const mockRunTrinityWritingPipeline = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn(() => ({ client: null }));

jest.unstable_mockModule('fs', () => ({
  promises: {
    mkdir: mockMkdir,
  },
}));

jest.unstable_mockModule('@shared/webFetcher.js', () => ({
  fetchAndClean: mockFetchAndClean,
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline,
}));

jest.unstable_mockModule('@platform/resilience/runtimeBudget.js', () => ({
  createRuntimeBudgetWithLimit: jest.fn((watchdogLimit: number, safetyBuffer = 0) => {
    const startedAt = Date.now();
    return {
      startedAt,
      hardDeadline: startedAt + watchdogLimit,
      watchdogLimit,
      safetyBuffer
    };
  }),
  getRemainingMs: jest.fn((budget: { hardDeadline: number }) => budget.hardDeadline - Date.now()),
}));

jest.unstable_mockModule('../src/services/openai.js', () => ({
  getDefaultModel: jest.fn(() => 'mock-model'),
}));

jest.unstable_mockModule('../src/services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter,
}));

jest.unstable_mockModule('../src/services/memory.js', () => ({
  setMemory: mockSetMemory,
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnvNumber: jest.fn((_name: string, fallback: number) => fallback),
  getEnvIntegerAtLeast: jest.fn((_name: string, fallback: number) => fallback),
  getEnv: jest.fn((name: string) => (
    name === 'OPENAI_API_KEY' ? 'test_key_for_mocking' : undefined
  )),
}));

const {
  buildResearchStorageTopicComponent,
  researchTopic,
} = await import('../src/services/research.js');

const RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES = 97;

describe('research storage topic component', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockSetMemory.mockResolvedValue(undefined);
  });

  it.each([
    'AI Safety & Alignment',
    '🧪'.repeat(250),
    '.../..\\CON:\u0000',
    'é'.repeat(500),
  ])('is deterministic, ASCII-only, and byte bounded for %s', (topic) => {
    const first = buildResearchStorageTopicComponent(topic);
    const second = buildResearchStorageTopicComponent(topic);

    expect(second).toBe(first);
    expect(first).toMatch(/^[a-z0-9-]+-[a-f0-9]{64}$/);
    expect(Buffer.byteLength(first, 'utf8'))
      .toBeLessThanOrEqual(RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES);
    expect(first).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/);
    expect(first.endsWith('.') || first.endsWith(' ')).toBe(false);
  });

  it.each([
    [
      'research topic',
      'research-topic-b96d11911e26c43860f1e6a9faf0cc86c560d75d1171130e3cde82b787319f64',
    ],
    [
      'café 😀',
      'caf-f6daef7a1cadabf1771de62c3d156fabded9d1416a1d5c32b5e129d7fe393399',
    ],
    [
      String.fromCharCode(0xd800),
      'topic-04db3564e4cccf62071139f2aaa261be651d5eeff60fd9579e93dd568d6f7830',
    ],
  ])('keeps the versioned storage key stable for %s', (topic, expected) => {
    expect(buildResearchStorageTopicComponent(topic)).toBe(expected);
  });

  it.each([
    ['a:b', 'ab'],
    ['a/b', 'a\\b'],
    ['CON', 'con'],
    ['é', 'e\u0301'],
    ['\ud800', '\ud801'],
  ])('distinguishes topics that can collide after sanitization: %s / %s', (left, right) => {
    expect(buildResearchStorageTopicComponent(left))
      .not.toBe(buildResearchStorageTopicComponent(right));
  });

  it('uses the exact 97-byte maximum for a 32-character ASCII slug', () => {
    const component = buildResearchStorageTopicComponent(
      'abcdefghijklmnopqrstuvwxyz0123456789',
    );

    expect(component.slice(0, 32)).toBe('abcdefghijklmnopqrstuvwxyz012345');
    expect(Buffer.byteLength(component, 'utf8'))
      .toBe(RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES);
  });

  it('uses one component for summary, source, and directory persistence', async () => {
    const topic = 'AI Safety: ../../CON';
    const url = 'https://example.com/research';
    const component = buildResearchStorageTopicComponent(topic);

    await researchTopic(topic, [url]);

    expect(mockSetMemory).toHaveBeenCalledWith(
      `research/${component}/summary`,
      expect.objectContaining({ topic }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockSetMemory).toHaveBeenCalledWith(
      `research/${component}/sources/1`,
      expect.objectContaining({ url }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockMkdir).toHaveBeenCalledWith(
      path.join('memory', 'research', component, 'sources'),
      { recursive: true },
    );
  });

  it('rejects over-limit input before provider, fetch, filesystem, or memory work', async () => {
    await expect(researchTopic('bounded topic', ['u'.repeat(2_049)]))
      .rejects.toMatchObject({ code: 'RESEARCH_REQUEST_INVALID' });

    expect(mockGetOpenAIClientOrAdapter).not.toHaveBeenCalled();
    expect(mockFetchAndClean).not.toHaveBeenCalled();
    expect(mockRunTrinityWritingPipeline).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockSetMemory).not.toHaveBeenCalled();
  });
});
