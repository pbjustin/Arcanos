import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  ArcanosCoreOperatorDispatchNotConfiguredError,
  configureArcanosCoreOperatorDispatch,
  getArcanosCoreOperatorDispatch,
  isArcanosCoreOperatorDispatchConfigured,
} from '../src/services/arcanosCoreOperatorDispatchPort.js';

describe('ARCANOS core operator dispatch port', () => {
  beforeEach(() => {
    configureArcanosCoreOperatorDispatch(null);
  });

  it('fails with a fixed error when composition has not configured the dispatcher', () => {
    expect(isArcanosCoreOperatorDispatchConfigured()).toBe(false);
    expect(() => getArcanosCoreOperatorDispatch()).toThrow(
      ArcanosCoreOperatorDispatchNotConfiguredError
    );

    try {
      getArcanosCoreOperatorDispatch();
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({
        code: 'ARCANOS_CORE_OPERATOR_DISPATCH_NOT_CONFIGURED',
        message: 'ARCANOS:CORE operator dispatch is not configured.',
      }));
    }
  });

  it('returns the explicitly configured dispatcher', async () => {
    const dispatcher = jest.fn(async () => null);
    configureArcanosCoreOperatorDispatch(dispatcher);

    expect(isArcanosCoreOperatorDispatchConfigured()).toBe(true);
    await expect(getArcanosCoreOperatorDispatch()({
      utterance: 'Write a short release note.',
    })).resolves.toBeNull();
    expect(dispatcher).toHaveBeenCalledWith({
      utterance: 'Write a short release note.',
    });
  });
});
