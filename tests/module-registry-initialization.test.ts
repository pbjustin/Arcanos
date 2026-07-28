import { describe, expect, it, jest } from '@jest/globals';

const loadModuleDefinitionsMock =
  jest.fn<() => Promise<Array<{
    route: string;
    definition: {
      name: string;
      description?: string;
      actions: Record<string, (payload: unknown) => Promise<unknown>>;
      gptIds?: string[];
    };
  }>>>();

jest.unstable_mockModule('../src/services/moduleLoader.js', () => ({
  loadModuleDefinitions: loadModuleDefinitionsMock
}));

const {
  getModulesForRegistry,
  initializeModuleRegistry,
  listRegisteredModules
} = await import('../src/services/moduleRegistry.js');

describe('module registry initialization', () => {
  it('coalesces concurrent loads and permits retry after a failed attempt', async () => {
    expect(() => listRegisteredModules()).toThrow(
      'Module registry is not initialized.'
    );

    let rejectFirstAttempt!: (error: Error) => void;
    const failedLoad = new Promise<never>((_resolve, reject) => {
      rejectFirstAttempt = reject;
    });
    loadModuleDefinitionsMock.mockReturnValueOnce(failedLoad);

    const firstAttempt = initializeModuleRegistry();
    const concurrentAttempt = initializeModuleRegistry();
    const firstRejection = expect(firstAttempt).rejects.toThrow('load failed');
    const concurrentRejection =
      expect(concurrentAttempt).rejects.toThrow('load failed');

    expect(concurrentAttempt).toBe(firstAttempt);
    expect(loadModuleDefinitionsMock).toHaveBeenCalledTimes(1);
    rejectFirstAttempt(new Error('load failed'));
    await Promise.all([firstRejection, concurrentRejection]);
    expect(() => getModulesForRegistry()).toThrow(
      'Module registry is not initialized.'
    );

    loadModuleDefinitionsMock.mockResolvedValueOnce([
      {
        route: 'example',
        definition: {
          name: 'ARCANOS:EXAMPLE',
          description: 'Example capability',
          actions: {
            query: jest.fn(async () => ({ ok: true }))
          },
          gptIds: ['arcanos-example']
        }
      }
    ]);

    const registry = await initializeModuleRegistry();
    const initializedAgain = await initializeModuleRegistry();

    expect(loadModuleDefinitionsMock).toHaveBeenCalledTimes(2);
    expect(initializedAgain).toBe(registry);
    expect(listRegisteredModules()).toHaveLength(1);
    expect(getModulesForRegistry()).toEqual([
      {
        id: 'ARCANOS:EXAMPLE',
        description: 'Example capability',
        route: 'example',
        actions: ['query']
      }
    ]);
  });
});
