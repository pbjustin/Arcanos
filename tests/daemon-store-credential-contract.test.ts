import { describe, expect, it, jest } from '@jest/globals';

import { createDaemonStore } from '../src/routes/daemonStore.js';

function createStoreHarness() {
  const logger = {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  const now = new Date('2026-07-16T12:00:00.000Z');
  const store = createDaemonStore({
    fs: {
      existsSync: jest.fn(() => false),
      mkdirSync: jest.fn(),
      readFileSync: jest.fn(() => ''),
      writeFileSync: jest.fn(),
    } as never,
    path: {
      dirname: jest.fn(() => 'phase2a-daemon-store'),
    },
    logger: logger as never,
    now: () => new Date(now.getTime()),
    tokensFilePath: 'phase2a-daemon-store/tokens.json',
  });

  return { logger, store };
}

describe('daemon-store credential binding contract', () => {
  it('requires the exact stored opaque credential without consuming the confirmation on mismatch', () => {
    const { logger, store } = createStoreHarness();
    const instanceId = 'phase2a-daemon';
    const credential = ['phase2a', 'daemon', 'sécurité'].join('-');
    const wrongSameLength = `${credential.slice(0, -1)}x`;
    const wrongDifferentLength = `${credential}x`;
    store.setTokenForInstance(instanceId, credential);
    const confirmation = store.createPendingActions(
      instanceId,
      [{ daemon: 'inspect', payload: { mode: 'read' }, summary: 'Read-only inspection' }],
      60_000,
    );

    expect(store.consumePendingActions(confirmation, instanceId, wrongSameLength)).toBe(-1);
    expect(store.consumePendingActions(confirmation, instanceId, wrongDifferentLength)).toBe(-1);
    expect(store.consumePendingActions(confirmation, instanceId, '')).toBe(-1);
    expect(store.consumePendingActions(confirmation, instanceId, credential)).toBe(1);
    expect(store.consumePendingActions(confirmation, instanceId, credential)).toBe(-1);

    const logOutput = JSON.stringify([
      logger.error.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
    ]);
    expect(
      [credential, wrongSameLength, wrongDifferentLength]
        .some((value) => logOutput.includes(value)),
    ).toBe(false);
  });
});
