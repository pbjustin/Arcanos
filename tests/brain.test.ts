import { jest } from '@jest/globals';
import { registerBrain, getBrain, brainExists } from '../src/brain/brainRegistry.js';
import { getActiveBrain } from '../src/brain/brainFactory.js';
import { MockBrain } from '../src/brain/mockBrain.js';

describe('Brain System', () => {
  beforeEach(() => {
    // Reset process.env for each test
    delete process.env.FORCE_MOCK;
    // We can't easily unregister from the singleton registry if we don't have a clear method
    // but we can test with different names or mock the registry if needed.
  });

  test('should register and retrieve a brain', () => {
    const mockBrain = new MockBrain();
    registerBrain('test-brain', mockBrain);
    expect(brainExists('test-brain')).toBe(true);
    expect(getBrain('test-brain')).toBe(mockBrain);
  });

  test('getActiveBrain should return MockBrain if FORCE_MOCK is true', () => {
    process.env.FORCE_MOCK = 'true';
    const brain = getActiveBrain();
    expect(brain).toBeInstanceOf(MockBrain);
  });

  test('getActiveBrain should throw if gpt5 is not registered and FORCE_MOCK is false', () => {
    process.env.FORCE_MOCK = 'false';
    // This test will pass if _clearRegistryForTests() is added and called in beforeEach
    expect(() => getActiveBrain()).toThrow(
      'CRITICAL: GPT5 worker not registered. Mock fallback is disabled in production.'
    );
  });
});
