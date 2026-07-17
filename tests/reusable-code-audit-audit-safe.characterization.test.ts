import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

type HierarchyModule = typeof import('../src/core/persistenceManagerHierarchy.js');
type PersistenceModule = typeof import('../src/services/persistenceManager.js');
type ToggleModule = typeof import('../src/services/auditSafeToggle.js');

interface AuditEvent {
  event: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

interface AuditSafeHarness {
  hierarchy: HierarchyModule;
  persistence: PersistenceModule;
  toggle: ToggleModule;
  coreAuditEvents: AuditEvent[];
  fileAuditEntries: AuditEvent[];
  appendFileMock: jest.Mock;
  insertAuditLogMock: jest.Mock;
  insertSaveMock: jest.Mock;
  setCoreAuditFailure: (error: Error | null) => void;
  setFileAuditFailure: (error: Error | null) => void;
}

const FIXED_NOW = new Date('2026-07-16T16:37:54.000Z');
const originalEnvironment = { ...process.env };

function restoreEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnvironment);
}

async function loadAuditSafeHarness(): Promise<AuditSafeHarness> {
  jest.resetModules();

  const coreAuditEvents: AuditEvent[] = [];
  const fileAuditEntries: AuditEvent[] = [];
  let coreAuditFailure: Error | null = null;
  let fileAuditFailure: Error | null = null;

  const insertSaveMock = jest.fn(async () => undefined);
  const insertAuditLogMock = jest.fn(
    async (event: string, payload: Record<string, unknown>, timestamp: number) => {
      coreAuditEvents.push({ event, payload, timestamp });
      if (coreAuditFailure) {
        throw coreAuditFailure;
      }
    }
  );
  const fakeAuditStore = {
    insertAuditLog: insertAuditLogMock,
    hasTable: jest.fn(async () => true),
    runInTransaction: jest.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation({ insertSave: insertSaveMock })
    ),
  };

  const appendFileMock = jest.fn(async (_filePath: string, rawEntry: string) => {
    fileAuditEntries.push(JSON.parse(rawEntry.trim()) as AuditEvent);
    if (fileAuditFailure) {
      throw fileAuditFailure;
    }
  });

  jest.unstable_mockModule('@core/db/auditStore.js', () => ({
    createAuditStore: () => fakeAuditStore,
  }));
  jest.unstable_mockModule('@platform/runtime/env.js', () => ({
    getEnv: (key: string, fallback?: string) => {
      const value = process.env[key];
      return value === undefined || value === '' ? fallback : value;
    },
  }));
  jest.unstable_mockModule('fs', () => ({
    promises: {
      appendFile: appendFileMock,
    },
  }));
  jest.unstable_mockModule('../src/services/openai.js', () => ({
    getDefaultModel: () => 'gpt-test',
  }));
  jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
    getOpenAIClientOrAdapter: () => ({ adapter: null, client: null }),
  }));
  jest.unstable_mockModule('@core/lib/errors/index.js', () => ({
    resolveErrorMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  }));
  jest.unstable_mockModule('@arcanos/openai/responseParsing', () => ({
    extractResponseOutputText: () => '',
  }));

  const [hierarchy, persistence, toggle] = await Promise.all([
    import('../src/core/persistenceManagerHierarchy.js'),
    import('../src/services/persistenceManager.js'),
    import('../src/services/auditSafeToggle.js'),
  ]);

  hierarchy.configureAuditStore(fakeAuditStore as never);

  return {
    hierarchy,
    persistence,
    toggle,
    coreAuditEvents,
    fileAuditEntries,
    appendFileMock,
    insertAuditLogMock,
    insertSaveMock,
    setCoreAuditFailure: (error) => {
      coreAuditFailure = error;
    },
    setFileAuditFailure: (error) => {
      fileAuditFailure = error;
    },
  };
}

beforeEach(() => {
  restoreEnvironment();
  delete process.env.DATABASE_URL;
  delete process.env.ALLOW_ROOT_OVERRIDE;
  delete process.env.ROOT_OVERRIDE_TOKEN;
  jest.useFakeTimers({ now: FIXED_NOW });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.resetModules();
  restoreEnvironment();
});

describe('reusable-code audit: audit-safe policy characterization', () => {
  it('preserves the independent initial states and cross-module visibility matrix', async () => {
    const harness = await loadAuditSafeHarness();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    expect({
      hierarchy: harness.hierarchy.getAuditSafeMode(),
      persistence: harness.persistence.getAuditSafeMode(),
      toggle: harness.toggle.getAuditSafeMode(),
    }).toEqual({
      hierarchy: { auditSafeMode: 'true', rootOverrideActive: false },
      persistence: { auditSafeMode: 'true', rootOverrideActive: false },
      toggle: 'true',
    });

    await harness.hierarchy.setAuditSafeMode('false');
    expect(harness.hierarchy.getAuditSafeMode()).toEqual({
      auditSafeMode: 'false',
      rootOverrideActive: false,
    });
    expect(harness.persistence.getAuditSafeMode()).toEqual({
      auditSafeMode: 'true',
      rootOverrideActive: false,
    });
    expect(harness.toggle.getAuditSafeMode()).toBe('true');

    await harness.persistence.setAuditSafeMode('passive');
    harness.toggle.setAuditSafeMode('log-only');

    expect({
      hierarchy: harness.hierarchy.getAuditSafeMode(),
      persistence: harness.persistence.getAuditSafeMode(),
      toggle: harness.toggle.getAuditSafeMode(),
    }).toEqual({
      hierarchy: { auditSafeMode: 'false', rootOverrideActive: false },
      persistence: { auditSafeMode: 'passive', rootOverrideActive: false },
      toggle: 'log-only',
    });
  });

  it('characterizes allowed modes, invalid inputs, and override activation/removal', async () => {
    const overrideToken = ['audit', 'characterization', 'token'].join('-');
    process.env.ALLOW_ROOT_OVERRIDE = 'true';
    process.env.ROOT_OVERRIDE_TOKEN = overrideToken;
    const harness = await loadAuditSafeHarness();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await harness.hierarchy.setAuditSafeMode('passive', {
      rootOverride: true,
      userRole: 'admin',
      ['token']: overrideToken,
    });
    await harness.persistence.setAuditSafeMode('false', {
      rootOverride: true,
      userRole: 'admin',
      ['token']: overrideToken,
    });
    harness.toggle.setAuditSafeMode('log-only');

    expect(harness.hierarchy.getAuditSafeMode()).toEqual({
      auditSafeMode: 'passive',
      rootOverrideActive: true,
    });
    expect(harness.persistence.getAuditSafeMode()).toEqual({
      auditSafeMode: 'false',
      rootOverrideActive: true,
    });
    expect(harness.toggle.getAuditSafeMode()).toBe('log-only');

    await harness.hierarchy.setAuditSafeMode('passive');
    await harness.persistence.setAuditSafeMode('false');
    expect(harness.hierarchy.getAuditSafeMode().rootOverrideActive).toBe(false);
    expect(harness.persistence.getAuditSafeMode().rootOverrideActive).toBe(false);

    await expect(
      harness.hierarchy.setAuditSafeMode('log-only' as never)
    ).rejects.toThrow("Invalid mode. Use 'true', 'false', or 'passive'.");
    await expect(
      harness.persistence.setAuditSafeMode('log-only' as never)
    ).rejects.toThrow("Invalid mode. Use 'true', 'false', or 'passive'.");
    expect(() => harness.toggle.setAuditSafeMode('invalid' as never)).toThrow(
      "Invalid mode. Use 'true', 'false', 'passive', or 'log-only'."
    );
  });

  it('keeps hierarchy state mutated when critical audit persistence rejects', async () => {
    const harness = await loadAuditSafeHarness();
    harness.setCoreAuditFailure(new Error('audit database unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(harness.hierarchy.setAuditSafeMode('false')).rejects.toThrow(
      'Critical audit logging failure.'
    );
    expect(harness.hierarchy.getAuditSafeMode()).toEqual({
      auditSafeMode: 'false',
      rootOverrideActive: false,
    });
  });

  it('keeps service state mutated while swallowing file-audit persistence failure', async () => {
    const harness = await loadAuditSafeHarness();
    harness.setFileAuditFailure(new Error('audit file unavailable'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(harness.persistence.setAuditSafeMode('false')).resolves.toBeUndefined();
    expect(harness.persistence.getAuditSafeMode()).toEqual({
      auditSafeMode: 'false',
      rootOverrideActive: false,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      '⚠️ Audit log failed:',
      'audit file unavailable'
    );
  });

  it('keeps toggle state mutated when its logging side effect throws', async () => {
    const harness = await loadAuditSafeHarness();
    jest.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('console unavailable');
    });

    expect(() => harness.toggle.setAuditSafeMode('passive')).toThrow(
      'console unavailable'
    );
    expect(harness.toggle.getAuditSafeMode()).toBe('passive');
  });

  it('characterizes failed override counters and successful-reset behavior', async () => {
    const harness = await loadAuditSafeHarness();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        harness.hierarchy.setAuditSafeMode('false', {
          rootOverride: true,
          userRole: 'guest',
          token: 'wrong',
        })
      ).rejects.toThrow('Unauthorized attempt');
    }
    await expect(
      harness.hierarchy.setAuditSafeMode('false', {
        rootOverride: true,
        userRole: 'guest',
        token: 'wrong',
      })
    ).rejects.toThrow('Too many failed override attempts');

    expect(
      harness.coreAuditEvents
        .filter((entry) => entry.event === 'ROOT_OVERRIDE_DENIED')
        .map((entry) => entry.payload.failedRootOverrideAttempts)
    ).toEqual([1, 2, 3, 4, 5, 6]);

    await harness.hierarchy.setAuditSafeMode('true');
    await expect(
      harness.hierarchy.setAuditSafeMode('false', {
        rootOverride: true,
        userRole: 'guest',
        token: 'wrong',
      })
    ).rejects.toThrow('Unauthorized attempt');

    expect(
      harness.coreAuditEvents
        .filter((entry) => entry.event === 'ROOT_OVERRIDE_DENIED')
        .at(-1)?.payload.failedRootOverrideAttempts
    ).toBe(1);
  });

  it('characterizes the persistence service override counter independently', async () => {
    const harness = await loadAuditSafeHarness();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        harness.persistence.setAuditSafeMode('false', {
          rootOverride: true,
          userRole: 'guest',
          token: 'wrong',
        })
      ).rejects.toThrow('Unauthorized attempt');
    }
    await expect(
      harness.persistence.setAuditSafeMode('false', {
        rootOverride: true,
        userRole: 'guest',
        token: 'wrong',
      })
    ).rejects.toThrow('Too many failed override attempts');

    expect(
      harness.fileAuditEntries
        .filter((entry) => entry.event === 'ROOT_OVERRIDE_DENIED')
        .map((entry) => entry.payload.failedRootOverrideAttempts)
    ).toEqual([1, 2, 3, 4, 5, 6]);

    await harness.persistence.setAuditSafeMode('true');
    await expect(
      harness.persistence.setAuditSafeMode('false', {
        rootOverride: true,
        userRole: 'guest',
        token: 'wrong',
      })
    ).rejects.toThrow('Unauthorized attempt');

    expect(
      harness.fileAuditEntries
        .filter((entry) => entry.event === 'ROOT_OVERRIDE_DENIED')
        .at(-1)?.payload.failedRootOverrideAttempts
    ).toBe(1);
  });

  it('characterizes strict, passive, disabled, and log-only persistence gates', async () => {
    const harness = await loadAuditSafeHarness();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(
      harness.hierarchy.saveWithAuditCheck('core-strict', { ok: false }, () => false)
    ).rejects.toThrow('Audit-Safe rejected invalid data');
    expect(
      harness.coreAuditEvents.map((entry) => entry.event)
    ).toContain('ROLLBACK_TRIGGERED');

    await harness.hierarchy.setAuditSafeMode('passive');
    await expect(
      harness.hierarchy.saveWithAuditCheck('core-passive', { ok: false }, () => false)
    ).resolves.toBe(true);
    expect(harness.insertSaveMock).toHaveBeenCalled();
    expect(
      harness.coreAuditEvents.map((entry) => entry.event)
    ).toContain('VALIDATOR_WARNING');

    const strictModuleName = 'service-strict-characterization';
    await expect(
      harness.persistence.saveWithAuditCheck(strictModuleName, { ok: false }, () => false)
    ).rejects.toThrow('Audit-Safe rejected invalid data');
    expect(harness.persistence.getModuleSaves(strictModuleName)).toEqual([]);

    await harness.persistence.setAuditSafeMode('passive');
    await expect(
      harness.persistence.saveWithAuditCheck(
        'service-passive-characterization',
        { ok: false },
        () => false
      )
    ).resolves.toBe(true);

    await harness.persistence.setAuditSafeMode('false');
    const disabledValidator = jest.fn(() => {
      throw new Error('must not run');
    });
    await expect(
      harness.persistence.saveWithAuditCheck(
        'service-disabled-characterization',
        { ok: false },
        disabledValidator
      )
    ).resolves.toBe(true);
    expect(disabledValidator).not.toHaveBeenCalled();

    harness.toggle.setAuditSafeMode('log-only');
    const toggleValidator = jest.fn(() => false);
    expect(
      harness.toggle.saveWithAuditCheck({ ok: false }, toggleValidator)
    ).toEqual({ ok: false });
    expect(toggleValidator).toHaveBeenCalledTimes(1);
  });

  it('preserves partial and interleaved hierarchy updates without rollback', async () => {
    const harness = await loadAuditSafeHarness();
    const auditResolvers: Array<() => void> = [];
    harness.insertAuditLogMock.mockImplementation(
      async (event: string, payload: Record<string, unknown>, timestamp: number) => {
        harness.coreAuditEvents.push({ event, payload, timestamp });
        await new Promise<void>((resolve) => {
          auditResolvers.push(resolve);
        });
      }
    );

    const firstUpdate = harness.hierarchy.setAuditSafeMode('false');
    const secondUpdate = harness.hierarchy.setAuditSafeMode('passive');

    try {
      expect(harness.hierarchy.getAuditSafeMode()).toEqual({
        auditSafeMode: 'passive',
        rootOverrideActive: false,
      });
      expect(auditResolvers).toHaveLength(2);

      auditResolvers[1]?.();
      await secondUpdate;
      auditResolvers[0]?.();
      await firstUpdate;
    } finally {
      for (const resolve of auditResolvers) {
        resolve();
      }
      await Promise.allSettled([firstUpdate, secondUpdate]);
    }

    expect(harness.hierarchy.getAuditSafeMode()).toEqual({
      auditSafeMode: 'passive',
      rootOverrideActive: false,
    });
  });

  it('preserves partial and interleaved persistence-service updates without rollback', async () => {
    const harness = await loadAuditSafeHarness();
    const auditResolvers: Array<() => void> = [];
    harness.appendFileMock.mockImplementation(async (_filePath: string, rawEntry: string) => {
      harness.fileAuditEntries.push(JSON.parse(rawEntry.trim()) as AuditEvent);
      await new Promise<void>((resolve) => {
        auditResolvers.push(resolve);
      });
    });

    const firstUpdate = harness.persistence.setAuditSafeMode('false');
    const secondUpdate = harness.persistence.setAuditSafeMode('passive');

    try {
      expect(harness.persistence.getAuditSafeMode()).toEqual({
        auditSafeMode: 'passive',
        rootOverrideActive: false,
      });
      expect(auditResolvers).toHaveLength(2);

      auditResolvers[1]?.();
      await secondUpdate;
      auditResolvers[0]?.();
      await firstUpdate;
    } finally {
      for (const resolve of auditResolvers) {
        resolve();
      }
      await Promise.allSettled([firstUpdate, secondUpdate]);
    }

    expect(harness.persistence.getAuditSafeMode()).toEqual({
      auditSafeMode: 'passive',
      rootOverrideActive: false,
    });
  });

  it('preserves state across repeated import and resets it after module isolation', async () => {
    const firstHarness = await loadAuditSafeHarness();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await firstHarness.hierarchy.setAuditSafeMode('false');
    await firstHarness.persistence.setAuditSafeMode('passive');
    firstHarness.toggle.setAuditSafeMode('log-only');

    const repeatedHierarchy = await import('../src/core/persistenceManagerHierarchy.js');
    const repeatedPersistence = await import('../src/services/persistenceManager.js');
    const repeatedToggle = await import('../src/services/auditSafeToggle.js');

    expect(repeatedHierarchy.getAuditSafeMode().auditSafeMode).toBe('false');
    expect(repeatedPersistence.getAuditSafeMode().auditSafeMode).toBe('passive');
    expect(repeatedToggle.getAuditSafeMode()).toBe('log-only');

    const isolatedHarness = await loadAuditSafeHarness();
    expect(isolatedHarness.hierarchy.getAuditSafeMode()).toEqual({
      auditSafeMode: 'true',
      rootOverrideActive: false,
    });
    expect(isolatedHarness.persistence.getAuditSafeMode()).toEqual({
      auditSafeMode: 'true',
      rootOverrideActive: false,
    });
    expect(isolatedHarness.toggle.getAuditSafeMode()).toBe('true');
  });
});
