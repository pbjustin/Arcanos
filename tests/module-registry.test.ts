import { jest } from '@jest/globals';

import {
  ModuleAccessDeniedError,
  createModuleRegistry
} from '../src/services/moduleRegistry.js';
import type {
  LoadedModule,
  ModuleDef,
  ModuleHandlerContext
} from '../src/services/moduleLoader.js';

function loadedModule(route: string, definition: ModuleDef): LoadedModule {
  return { route, definition };
}

describe('module registry', () => {
  test('builds an immutable registry generation with defensive projections', () => {
    const publicDefinition: ModuleDef = {
      name: 'ARCANOS:PUBLIC',
      description: 'Public capability',
      actions: {
        query: jest.fn(async () => ({ ok: true }))
      },
      actionMetadata: {
        query: {
          risk: 'readonly',
          readOnly: true,
          requiresConfirmation: false
        }
      },
      gptIds: ['arcanos-public']
    };
    const hiddenDefinition: ModuleDef = {
      name: 'ARCANOS:HIDDEN',
      actions: {
        inspect: jest.fn(async () => ({ ok: true }))
      },
      exposeLegacyRoute: false
    };
    const protectedDefinition: ModuleDef = {
      name: 'ARCANOS:PROTECTED',
      actions: {
        status: jest.fn(async () => ({ ok: true }))
      },
      gptAccessOnly: true,
      exposeLegacyRoute: false
    };

    const registry = createModuleRegistry([
      loadedModule('public', publicDefinition),
      loadedModule('hidden', hiddenDefinition),
      loadedModule('protected', protectedDefinition)
    ]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(registry.getModulesForRegistry().map((entry) => entry.id)).toEqual([
      'ARCANOS:PUBLIC',
      'ARCANOS:HIDDEN',
      'ARCANOS:PROTECTED'
    ]);
    expect(registry.getPublicModulesForRegistry()).toEqual([
      {
        name: 'ARCANOS:PUBLIC',
        description: 'Public capability',
        route: 'public',
        actions: ['query'],
        gptIds: ['arcanos-public']
      }
    ]);
    expect(registry.getModuleMetadata('public')).toMatchObject({
      name: 'ARCANOS:PUBLIC',
      route: 'public',
      actions: ['query'],
      actionMetadata: {
        query: {
          risk: 'readonly',
          readOnly: true,
          requiresConfirmation: false
        }
      }
    });

    const firstSnapshot = registry.listRegisteredModules();
    firstSnapshot[0] = loadedModule('changed', hiddenDefinition);
    expect(registry.listRegisteredModules()[0]).toEqual({
      route: 'public',
      definition: publicDefinition
    });
  });

  test('rejects duplicate routes and names', () => {
    const first: ModuleDef = {
      name: 'ARCANOS:FIRST',
      actions: { query: jest.fn(async () => null) }
    };
    const second: ModuleDef = {
      name: 'ARCANOS:SECOND',
      actions: { query: jest.fn(async () => null) }
    };

    expect(() =>
      createModuleRegistry([
        loadedModule('duplicate', first),
        loadedModule('duplicate', second)
      ])
    ).toThrow('Duplicate registered module route: duplicate');
    expect(() =>
      createModuleRegistry([
        loadedModule('first', first),
        loadedModule('second', first)
      ])
    ).toThrow('Duplicate registered module name: ARCANOS:FIRST');
  });

  test('requires trusted GPT Access identity for protected module dispatch', async () => {
    const ordinaryHandler = jest.fn(async () => ({ kind: 'ordinary' }));
    const protectedHandler = jest.fn(async (
      _payload: unknown,
      context?: ModuleHandlerContext
    ) => ({ principalId: context?.principalId }));
    const registry = createModuleRegistry([
      loadedModule('ordinary', {
        name: 'ARCANOS:ORDINARY',
        actions: { query: ordinaryHandler }
      }),
      loadedModule('protected', {
        name: 'ARCANOS:PROTECTED',
        actions: { status: protectedHandler },
        gptAccessOnly: true,
        exposeLegacyRoute: false
      })
    ]);
    const context: ModuleHandlerContext = {
      source: 'gpt-access',
      principalId: 'principal',
      workspaceId: 'workspace',
      actorKey: 'actor'
    };

    await expect(
      registry.dispatchModuleAction('ARCANOS:PROTECTED', 'status', {})
    ).rejects.toBeInstanceOf(ModuleAccessDeniedError);
    await expect(
      registry.dispatchModuleAction(
        'ARCANOS:PROTECTED',
        'status',
        {},
        { ...context, actorKey: '' }
      )
    ).rejects.toBeInstanceOf(ModuleAccessDeniedError);
    await expect(
      registry.dispatchModuleAction('ARCANOS:PROTECTED', 'status', {}, context)
    ).resolves.toEqual({ principalId: 'principal' });

    await registry.dispatchModuleAction(
      'ARCANOS:ORDINARY',
      'query',
      {},
      context
    );
    expect(ordinaryHandler).toHaveBeenCalledWith({});
    expect(protectedHandler).toHaveBeenCalledWith({}, context);
  });
});
